import type { DB } from "./db.ts";

/** Presence is online if a heartbeat arrived within this window. */
export const ONLINE_WINDOW_MS = 2 * 60 * 1000;

export interface InstanceRow {
  id: number;
  handle: string;
  public_key: string;
  url: string;
  display_name: string | null;
  created_at: string;
  last_seen: string | null;
}

export interface Presence {
  online: boolean;
  lastSeen: string | null;
}

export function presenceOf(lastSeen: string | null, now = Date.now()): Presence {
  if (!lastSeen) return { online: false, lastSeen: null };
  const seenMs = Date.parse(`${lastSeen}Z`); // stored as UTC 'YYYY-MM-DD HH:MM:SS'
  const online = Number.isFinite(seenMs) && now - seenMs < ONLINE_WINDOW_MS;
  return { online, lastSeen };
}

// ---- instances ---------------------------------------------------------

export function getInstanceByHandle(db: DB, handle: string): InstanceRow | undefined {
  return db.prepare("SELECT * FROM instance WHERE handle = ?").get(handle) as
    | InstanceRow
    | undefined;
}

export function getInstanceByKey(db: DB, key: string): InstanceRow | undefined {
  return db.prepare("SELECT * FROM instance WHERE public_key = ?").get(key) as
    | InstanceRow
    | undefined;
}

export type UpsertResult =
  | { ok: true; row: InstanceRow }
  | { ok: false; error: string };

/**
 * Register or update an instance. The public key is the immutable identity; a
 * caller may change its own handle/url/name. A handle is owned by the first key
 * to claim it — another key cannot take it (trust on first use).
 */
export function upsertInstance(
  db: DB,
  key: string,
  fields: { handle: string; url: string; displayName?: string | null },
): UpsertResult {
  const handle = fields.handle.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,32}$/.test(handle))
    return { ok: false, error: "handle must be 2-32 chars: a-z 0-9 _ -" };
  if (!/^https?:\/\//.test(fields.url))
    return { ok: false, error: "url must be http(s)" };

  const byHandle = getInstanceByHandle(db, handle);
  if (byHandle && byHandle.public_key !== key)
    return { ok: false, error: "handle already taken" };

  const existing = getInstanceByKey(db, key);
  if (existing) {
    db.prepare(
      "UPDATE instance SET handle = ?, url = ?, display_name = ? WHERE public_key = ?",
    ).run(handle, fields.url, fields.displayName ?? null, key);
  } else {
    db.prepare(
      "INSERT INTO instance (handle, public_key, url, display_name) VALUES (?, ?, ?, ?)",
    ).run(handle, key, fields.url, fields.displayName ?? null);
  }
  return { ok: true, row: getInstanceByKey(db, key)! };
}

/**
 * Rotate an instance's identity key. Signed by the OLD key (proving ownership);
 * the new key is moved across the instance, friendships, and cache atomically.
 */
export function rotateKey(
  db: DB,
  oldKey: string,
  newKey: string,
): { ok: boolean; error?: string } {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(newKey))
    return { ok: false, error: "invalid new key" };
  if (!getInstanceByKey(db, oldKey)) return { ok: false, error: "not registered" };
  if (getInstanceByKey(db, newKey)) return { ok: false, error: "new key already in use" };

  db.exec("BEGIN");
  try {
    db.prepare("UPDATE instance SET public_key = ? WHERE public_key = ?").run(newKey, oldKey);
    db.prepare("UPDATE friendship SET requester_key = ? WHERE requester_key = ?").run(newKey, oldKey);
    db.prepare("UPDATE friendship SET addressee_key = ? WHERE addressee_key = ?").run(newKey, oldKey);
    db.prepare("UPDATE shared_cache SET owner_key = ? WHERE owner_key = ?").run(newKey, oldKey);
    db.prepare("UPDATE reaction SET owner_key = ? WHERE owner_key = ?").run(newKey, oldKey);
    db.prepare("UPDATE reaction SET actor_key = ? WHERE actor_key = ?").run(newKey, oldKey);
    db.prepare("UPDATE comment SET owner_key = ? WHERE owner_key = ?").run(newKey, oldKey);
    db.prepare("UPDATE comment SET actor_key = ? WHERE actor_key = ?").run(newKey, oldKey);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true };
}

/** Permanently remove an instance and everything referencing it (signed by it). */
export function deleteAccount(db: DB, key: string): void {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM friendship WHERE requester_key = ? OR addressee_key = ?").run(key, key);
    db.prepare("DELETE FROM shared_cache WHERE owner_key = ?").run(key);
    db.prepare("DELETE FROM reaction WHERE owner_key = ? OR actor_key = ?").run(key, key);
    db.prepare("DELETE FROM comment WHERE owner_key = ? OR actor_key = ?").run(key, key);
    db.prepare("DELETE FROM instance WHERE public_key = ?").run(key);
    db.exec("COMMIT");
  } catch {
    db.exec("ROLLBACK");
  }
}

/** Record a heartbeat. Returns the new last_seen, or null if not registered. */
export function touchInstance(db: DB, key: string): string | null {
  const info = db
    .prepare("UPDATE instance SET last_seen = datetime('now') WHERE public_key = ?")
    .run(key);
  if (info.changes === 0) return null;
  return (
    db.prepare("SELECT last_seen FROM instance WHERE public_key = ?").get(key) as {
      last_seen: string;
    }
  ).last_seen;
}

// ---- friendships -------------------------------------------------------

export interface FriendshipRow {
  id: number;
  requester_key: string;
  addressee_key: string;
  status: "pending" | "accepted" | "declined";
  scope: string;
  created_at: string;
  updated_at: string;
}

/** Create or refresh a friend request, recording what the requester shares. */
export function requestFriend(
  db: DB,
  requesterKey: string,
  addresseeKey: string,
  scope: string[],
): { ok: boolean; error?: string } {
  if (requesterKey === addresseeKey)
    return { ok: false, error: "cannot friend yourself" };
  db.prepare(
    `INSERT INTO friendship (requester_key, addressee_key, status, requester_scope)
     VALUES (?, ?, 'pending', ?)
     ON CONFLICT (requester_key, addressee_key)
     DO UPDATE SET status = 'pending', requester_scope = excluded.requester_scope, updated_at = datetime('now')`,
  ).run(requesterKey, addresseeKey, JSON.stringify(scope));
  return { ok: true };
}

/** Addressee accepts or declines, recording what the addressee shares back. */
export function respondFriend(
  db: DB,
  addresseeKey: string,
  requesterKey: string,
  accept: boolean,
  scope: string[],
): { ok: boolean; error?: string } {
  const row = db
    .prepare(
      "SELECT * FROM friendship WHERE requester_key = ? AND addressee_key = ?",
    )
    .get(requesterKey, addresseeKey) as FriendshipRow | undefined;
  if (!row) return { ok: false, error: "no such request" };
  db.prepare(
    "UPDATE friendship SET status = ?, addressee_scope = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(accept ? "accepted" : "declined", JSON.stringify(scope), row.id);
  return { ok: true };
}

export interface FriendView {
  handle: string;
  publicKey: string;
  url: string;
  displayName: string | null;
  sharesWithMe: string[]; // what the friend shares with me (I may read this)
  iShareWith: string[]; // what I share with the friend (they may read this)
  presence: Presence;
}

interface FriendRow {
  requester_key: string;
  addressee_key: string;
  requester_scope: string;
  addressee_scope: string;
}

/** Accepted friends of `key` (either direction), with directional scopes. */
export function listFriends(db: DB, key: string, now = Date.now()): FriendView[] {
  const rows = db
    .prepare(
      `SELECT requester_key, addressee_key, requester_scope, addressee_scope
         FROM friendship
        WHERE status = 'accepted' AND (requester_key = ? OR addressee_key = ?)`,
    )
    .all(key, key) as unknown as FriendRow[];

  const out: FriendView[] = [];
  for (const r of rows) {
    const meIsRequester = r.requester_key === key;
    const otherKey = meIsRequester ? r.addressee_key : r.requester_key;
    const inst = getInstanceByKey(db, otherKey);
    if (!inst) continue;
    out.push({
      handle: inst.handle,
      publicKey: inst.public_key,
      url: inst.url,
      displayName: inst.display_name,
      iShareWith: safeScope(meIsRequester ? r.requester_scope : r.addressee_scope),
      sharesWithMe: safeScope(meIsRequester ? r.addressee_scope : r.requester_scope),
      presence: presenceOf(inst.last_seen, now),
    });
  }
  return out;
}

export interface PendingView {
  handle: string;
  publicKey: string;
  scope: string[];
}

/** Pending requests addressed to `key` (incoming) and sent by `key` (outgoing). */
export function listPending(
  db: DB,
  key: string,
): { incoming: PendingView[]; outgoing: PendingView[] } {
  const map = (rows: { scope: string; other_key: string }[]): PendingView[] =>
    rows
      .map((r) => {
        const inst = getInstanceByKey(db, r.other_key);
        return inst
          ? { handle: inst.handle, publicKey: inst.public_key, scope: safeScope(r.scope) }
          : null;
      })
      .filter((v): v is PendingView => v !== null);

  const incoming = db
    .prepare(
      "SELECT requester_scope AS scope, requester_key AS other_key FROM friendship WHERE addressee_key = ? AND status = 'pending'",
    )
    .all(key) as { scope: string; other_key: string }[];
  const outgoing = db
    .prepare(
      "SELECT requester_scope AS scope, addressee_key AS other_key FROM friendship WHERE requester_key = ? AND status = 'pending'",
    )
    .all(key) as { scope: string; other_key: string }[];

  return { incoming: map(incoming), outgoing: map(outgoing) };
}

function safeScope(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ---- shared cache (offline-viewable subset) ----------------------------

/** Scopes `ownerKey` shares with `friendKey`, or null if they aren't friends. */
export function sharedScopesBetween(
  db: DB,
  ownerKey: string,
  friendKey: string,
): string[] | null {
  const row = db
    .prepare(
      `SELECT requester_key, requester_scope, addressee_scope FROM friendship
        WHERE status = 'accepted'
          AND ((requester_key = ? AND addressee_key = ?)
            OR (requester_key = ? AND addressee_key = ?))`,
    )
    .get(ownerKey, friendKey, friendKey, ownerKey) as
    | { requester_key: string; requester_scope: string; addressee_scope: string }
    | undefined;
  if (!row) return null;
  // The owner's grant is requester_scope if the owner made the request.
  return safeScope(row.requester_key === ownerKey ? row.requester_scope : row.addressee_scope);
}

export function putCache(db: DB, ownerKey: string, scope: string, payload: string): void {
  db.prepare(
    `INSERT INTO shared_cache (owner_key, scope, payload) VALUES (?, ?, ?)
     ON CONFLICT (owner_key, scope)
     DO UPDATE SET payload = excluded.payload, updated_at = datetime('now')`,
  ).run(ownerKey, scope, payload);
}

export function getCache(
  db: DB,
  ownerKey: string,
  scope: string,
): { payload: string; updatedAt: string } | null {
  const row = db
    .prepare("SELECT payload, updated_at FROM shared_cache WHERE owner_key = ? AND scope = ?")
    .get(ownerKey, scope) as { payload: string; updated_at: string } | undefined;
  return row ? { payload: row.payload, updatedAt: row.updated_at } : null;
}

// ---- social (kudos + comments on shared activities) ----------------------

/** Owner-local activity reference, e.g. "2026-06-09:123". Opaque, no slashes. */
const REF_RE = /^[A-Za-z0-9:._-]{1,64}$/;

export function validRef(ref: unknown): ref is string {
  return typeof ref === "string" && REF_RE.test(ref);
}

export const MAX_COMMENT_CHARS = 1000;

/** Accepted friendship between two keys (either direction). */
export function areFriends(db: DB, a: string, b: string): boolean {
  return sharedScopesBetween(db, a, b) !== null;
}

/** Add or remove a kudos (toggle). Returns the new state and total. */
export function toggleKudos(
  db: DB,
  ownerKey: string,
  actorKey: string,
  ref: string,
): { kudosed: boolean; count: number } {
  const existing = db
    .prepare(
      "SELECT id FROM reaction WHERE owner_key = ? AND actor_key = ? AND activity_ref = ?",
    )
    .get(ownerKey, actorKey, ref) as { id: number } | undefined;
  if (existing) {
    db.prepare("DELETE FROM reaction WHERE id = ?").run(existing.id);
  } else {
    db.prepare(
      "INSERT INTO reaction (owner_key, actor_key, activity_ref) VALUES (?, ?, ?)",
    ).run(ownerKey, actorKey, ref);
  }
  const { n } = db
    .prepare(
      "SELECT COUNT(*) AS n FROM reaction WHERE owner_key = ? AND activity_ref = ?",
    )
    .get(ownerKey, ref) as { n: number };
  return { kudosed: !existing, count: n };
}

export function addComment(
  db: DB,
  ownerKey: string,
  actorKey: string,
  ref: string,
  body: string,
): { ok: true; id: number } | { ok: false; error: string } {
  const text = body.trim();
  if (!text) return { ok: false, error: "comment is empty" };
  if (text.length > MAX_COMMENT_CHARS)
    return { ok: false, error: `comment too long (max ${MAX_COMMENT_CHARS})` };
  const info = db
    .prepare(
      "INSERT INTO comment (owner_key, actor_key, activity_ref, body) VALUES (?, ?, ?, ?)",
    )
    .run(ownerKey, actorKey, ref, text);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

/** Delete a comment; allowed for its author or the activity's owner. */
export function deleteComment(db: DB, id: number, callerKey: string): boolean {
  const info = db
    .prepare("DELETE FROM comment WHERE id = ? AND (actor_key = ? OR owner_key = ?)")
    .run(id, callerKey, callerKey);
  return info.changes > 0;
}

export interface ActivitySocial {
  kudos: { handle: string; displayName: string | null }[];
  myKudos: boolean;
  comments: {
    id: number;
    handle: string;
    displayName: string | null;
    body: string;
    createdAt: string;
    mine: boolean;
  }[];
}

/** Everything social on one activity, as seen by `viewerKey`. */
export function activitySocial(
  db: DB,
  ownerKey: string,
  ref: string,
  viewerKey: string,
): ActivitySocial {
  const kudosRows = db
    .prepare(
      `SELECT r.actor_key, i.handle, i.display_name FROM reaction r
         JOIN instance i ON i.public_key = r.actor_key
        WHERE r.owner_key = ? AND r.activity_ref = ?
        ORDER BY r.created_at`,
    )
    .all(ownerKey, ref) as { actor_key: string; handle: string; display_name: string | null }[];
  const commentRows = db
    .prepare(
      `SELECT c.id, c.actor_key, c.body, c.created_at, i.handle, i.display_name
         FROM comment c JOIN instance i ON i.public_key = c.actor_key
        WHERE c.owner_key = ? AND c.activity_ref = ?
        ORDER BY c.created_at, c.id`,
    )
    .all(ownerKey, ref) as {
    id: number;
    actor_key: string;
    body: string;
    created_at: string;
    handle: string;
    display_name: string | null;
  }[];
  return {
    kudos: kudosRows.map((r) => ({ handle: r.handle, displayName: r.display_name })),
    myKudos: kudosRows.some((r) => r.actor_key === viewerKey),
    comments: commentRows.map((c) => ({
      id: c.id,
      handle: c.handle,
      displayName: c.display_name,
      body: c.body,
      createdAt: c.created_at,
      mine: c.actor_key === viewerKey,
    })),
  };
}

export interface SocialCounts {
  kudos: number;
  comments: number;
  mine: boolean; // viewer has kudos'd this activity
}

/** Batch kudos/comment counts for a feed. Unauthorized items return zeros. */
export function socialCounts(
  db: DB,
  items: { ownerKey: string; ref: string }[],
  viewerKey: string,
): SocialCounts[] {
  const kudosStmt = db.prepare(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN actor_key = ? THEN 1 ELSE 0 END) AS mine
       FROM reaction WHERE owner_key = ? AND activity_ref = ?`,
  );
  const commentStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM comment WHERE owner_key = ? AND activity_ref = ?",
  );
  return items.map(({ ownerKey, ref }) => {
    const authorized =
      ownerKey === viewerKey || (validRef(ref) && areFriends(db, ownerKey, viewerKey));
    if (!authorized) return { kudos: 0, comments: 0, mine: false };
    const k = kudosStmt.get(viewerKey, ownerKey, ref) as { n: number; mine: number | null };
    const c = commentStmt.get(ownerKey, ref) as { n: number };
    return { kudos: k.n, comments: c.n, mine: (k.mine ?? 0) > 0 };
  });
}
