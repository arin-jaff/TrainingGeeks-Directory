import { Hono } from "hono";
import type { DB } from "./db.ts";
import { type AuthVars, jsonBody, requireSignature } from "./auth.ts";
import {
  getCache,
  getInstanceByHandle,
  listFriends,
  listPending,
  presenceOf,
  putCache,
  requestFriend,
  respondFriend,
  sharedScopesBetween,
  touchInstance,
  upsertInstance,
} from "./repo.ts";

/** Normalize a requested scope to a clean string array. */
function asScope(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").slice(0, 32);
}

/** Mount the signed /v1 coordination API. All routes require a valid signature. */
export function v1Routes(db: DB) {
  const v1 = new Hono<{ Variables: AuthVars }>();
  v1.use("*", requireSignature());

  // Register / update this instance.
  v1.post("/register", (c) => {
    const key = c.get("signerKey");
    const body = jsonBody<{ handle?: string; url?: string; displayName?: string }>(
      c.get("rawBody"),
    );
    if (!body.handle || !body.url)
      return c.json({ error: "handle and url are required" }, 400);
    const res = upsertInstance(db, key, {
      handle: body.handle,
      url: body.url,
      displayName: body.displayName ?? null,
    });
    if (!res.ok) return c.json({ error: res.error }, 409);
    return c.json({ ok: true, handle: res.row.handle });
  });

  // Presence heartbeat.
  v1.post("/heartbeat", (c) => {
    const lastSeen = touchInstance(db, c.get("signerKey"));
    if (lastSeen === null)
      return c.json({ error: "register before sending heartbeats" }, 404);
    return c.json({ ok: true, lastSeen });
  });

  // Resolve a handle to its public key, URL, and presence.
  v1.get("/resolve/:handle", (c) => {
    const inst = getInstanceByHandle(db, c.req.param("handle").toLowerCase());
    if (!inst) return c.json({ error: "unknown handle" }, 404);
    return c.json({
      handle: inst.handle,
      publicKey: inst.public_key,
      url: inst.url,
      displayName: inst.display_name,
      presence: presenceOf(inst.last_seen),
    });
  });

  // Send a friend request to a handle.
  v1.post("/friends/request", (c) => {
    const key = c.get("signerKey");
    const body = jsonBody<{ handle?: string; scope?: unknown }>(c.get("rawBody"));
    if (!body.handle) return c.json({ error: "handle is required" }, 400);
    const target = getInstanceByHandle(db, body.handle.toLowerCase());
    if (!target) return c.json({ error: "unknown handle" }, 404);
    const res = requestFriend(db, key, target.public_key, asScope(body.scope));
    if (!res.ok) return c.json({ error: res.error }, 400);
    return c.json({ ok: true, status: "pending" });
  });

  // Accept or decline an incoming request, granting a scope.
  v1.post("/friends/respond", (c) => {
    const key = c.get("signerKey");
    const body = jsonBody<{ handle?: string; accept?: boolean; scope?: unknown }>(
      c.get("rawBody"),
    );
    if (!body.handle || typeof body.accept !== "boolean")
      return c.json({ error: "handle and accept are required" }, 400);
    const requester = getInstanceByHandle(db, body.handle.toLowerCase());
    if (!requester) return c.json({ error: "unknown handle" }, 404);
    const res = respondFriend(
      db,
      key,
      requester.public_key,
      body.accept,
      asScope(body.scope),
    );
    if (!res.ok) return c.json({ error: res.error }, 404);
    return c.json({ ok: true, status: body.accept ? "accepted" : "declined" });
  });

  // List my friends and pending requests, with presence.
  v1.get("/friends", (c) => {
    const key = c.get("signerKey");
    const { incoming, outgoing } = listPending(db, key);
    return c.json({ friends: listFriends(db, key), incoming, outgoing });
  });

  // Owner pushes a cached copy of one shared scope (so offline friends can
  // still view it). Body: { payload }. Stored verbatim, served to friends only.
  v1.put("/cache/:scope", (c) => {
    const body = jsonBody<{ payload?: unknown }>(c.get("rawBody"));
    if (body.payload === undefined)
      return c.json({ error: "payload required" }, 400);
    putCache(db, c.get("signerKey"), c.req.param("scope"), JSON.stringify(body.payload));
    return c.json({ ok: true });
  });

  // A friend reads an owner's cached scope (used when the owner is offline).
  // Authorized against the friend graph + the owner's directional scope.
  v1.get("/cache/:handle/:scope", (c) => {
    const callerKey = c.get("signerKey");
    const owner = getInstanceByHandle(db, c.req.param("handle").toLowerCase());
    if (!owner) return c.json({ error: "unknown handle" }, 404);
    const scope = c.req.param("scope");
    const shared = sharedScopesBetween(db, owner.public_key, callerKey);
    if (!shared || !shared.includes(scope))
      return c.json({ error: "not shared with you" }, 403);
    const cached = getCache(db, owner.public_key, scope);
    if (!cached) return c.json({ error: "no cached data" }, 404);
    return c.json({ scope, updatedAt: cached.updatedAt, payload: JSON.parse(cached.payload) });
  });

  return v1;
}
