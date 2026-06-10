import { Hono } from "hono";
import type { DB } from "./db.ts";
import { type AuthVars, jsonBody, requireSignature } from "./auth.ts";
import { rateLimit } from "./ratelimit.ts";
import {
  activitySocial,
  addComment,
  areFriends,
  deleteAccount,
  deleteComment,
  getCache,
  getInstanceByHandle,
  listFriends,
  listPending,
  presenceOf,
  putCache,
  requestFriend,
  respondFriend,
  rotateKey,
  sharedScopesBetween,
  socialCounts,
  toggleKudos,
  touchInstance,
  upsertInstance,
  validRef,
} from "./repo.ts";

/** Max size of a pushed cache payload (abuse guard). */
const MAX_CACHE_BYTES = 1_000_000;

/** Normalize a requested scope to a clean string array. */
function asScope(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").slice(0, 32);
}

/** Mount the signed /v1 coordination API. All routes require a valid signature. */
export function v1Routes(db: DB) {
  const v1 = new Hono<{ Variables: AuthVars }>();
  // Cheap IP-based abuse guard before the (more expensive) signature check.
  v1.use("*", rateLimit({ capacity: 120, refillPerSec: 2 }));
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
    if (c.get("rawBody").length > MAX_CACHE_BYTES)
      return c.json({ error: "payload too large" }, 413);
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

  // ---- social: kudos + comments on shared activities --------------------
  // The activity itself lives on the owner's instance; reactions live here so
  // they survive the owner being offline. Writes require an accepted
  // friendship with the owner; reads allow the owner too.

  // Toggle a kudos on a friend's activity. Body: { handle, ref }.
  v1.post("/social/kudos", (c) => {
    const key = c.get("signerKey");
    const body = jsonBody<{ handle?: string; ref?: unknown }>(c.get("rawBody"));
    if (!body.handle || !validRef(body.ref))
      return c.json({ error: "handle and ref are required" }, 400);
    const owner = getInstanceByHandle(db, body.handle.toLowerCase());
    if (!owner) return c.json({ error: "unknown handle" }, 404);
    if (owner.public_key === key)
      return c.json({ error: "cannot kudos your own activity" }, 400);
    if (!areFriends(db, owner.public_key, key))
      return c.json({ error: "not friends" }, 403);
    return c.json({ ok: true, ...toggleKudos(db, owner.public_key, key, body.ref) });
  });

  // Comment on an activity. Body: { handle, ref, body }. Owner may comment too.
  v1.post("/social/comment", (c) => {
    const key = c.get("signerKey");
    const body = jsonBody<{ handle?: string; ref?: unknown; body?: string }>(
      c.get("rawBody"),
    );
    if (!body.handle || !validRef(body.ref) || typeof body.body !== "string")
      return c.json({ error: "handle, ref and body are required" }, 400);
    const owner = getInstanceByHandle(db, body.handle.toLowerCase());
    if (!owner) return c.json({ error: "unknown handle" }, 404);
    if (owner.public_key !== key && !areFriends(db, owner.public_key, key))
      return c.json({ error: "not friends" }, 403);
    const res = addComment(db, owner.public_key, key, body.ref, body.body);
    if (!res.ok) return c.json({ error: res.error }, 400);
    return c.json({ ok: true, id: res.id });
  });

  // Delete a comment — allowed for its author or the activity's owner.
  v1.delete("/social/comment/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
    if (!deleteComment(db, id, c.get("signerKey")))
      return c.json({ error: "not found or not yours" }, 404);
    return c.json({ ok: true });
  });

  // Everything social on one activity (kudos givers + comment thread).
  v1.get("/social/:handle/:ref", (c) => {
    const key = c.get("signerKey");
    const ref = c.req.param("ref");
    if (!validRef(ref)) return c.json({ error: "bad ref" }, 400);
    const owner = getInstanceByHandle(db, c.req.param("handle").toLowerCase());
    if (!owner) return c.json({ error: "unknown handle" }, 404);
    if (owner.public_key !== key && !areFriends(db, owner.public_key, key))
      return c.json({ error: "not friends" }, 403);
    return c.json(activitySocial(db, owner.public_key, ref, key));
  });

  // Batch kudos/comment counts for a feed. Body: { items: [{handle, ref}] }.
  // Unauthorized or unknown items come back as zeros (no existence leak).
  v1.post("/social/summary", (c) => {
    const key = c.get("signerKey");
    const body = jsonBody<{ items?: { handle?: string; ref?: string }[] }>(
      c.get("rawBody"),
    );
    if (!Array.isArray(body.items)) return c.json({ error: "items required" }, 400);
    const items = body.items.slice(0, 100).map((it) => {
      const owner = it.handle ? getInstanceByHandle(db, it.handle.toLowerCase()) : undefined;
      return { ownerKey: owner?.public_key ?? "", ref: validRef(it.ref) ? it.ref : "" };
    });
    return c.json({ counts: socialCounts(db, items, key) });
  });

  // Rotate this instance's identity key (signed by the current/old key).
  v1.post("/rotate", (c) => {
    const body = jsonBody<{ newKey?: string }>(c.get("rawBody"));
    if (!body.newKey) return c.json({ error: "newKey required" }, 400);
    const res = rotateKey(db, c.get("signerKey"), body.newKey);
    if (!res.ok) return c.json({ error: res.error }, 409);
    return c.json({ ok: true });
  });

  // Permanently delete this instance and its friendships/cache (signed by it).
  v1.delete("/account", (c) => {
    deleteAccount(db, c.get("signerKey"));
    return c.json({ ok: true });
  });

  return v1;
}
