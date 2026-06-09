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

/** Create or refresh a friend request from requester → addressee. */
export function requestFriend(
  db: DB,
  requesterKey: string,
  addresseeKey: string,
  scope: string[],
): { ok: boolean; error?: string } {
  if (requesterKey === addresseeKey)
    return { ok: false, error: "cannot friend yourself" };
  db.prepare(
    `INSERT INTO friendship (requester_key, addressee_key, status, scope)
     VALUES (?, ?, 'pending', ?)
     ON CONFLICT (requester_key, addressee_key)
     DO UPDATE SET status = 'pending', scope = excluded.scope, updated_at = datetime('now')`,
  ).run(requesterKey, addresseeKey, JSON.stringify(scope));
  return { ok: true };
}

/** Addressee accepts or declines a pending request, setting the granted scope. */
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
    "UPDATE friendship SET status = ?, scope = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(accept ? "accepted" : "declined", JSON.stringify(scope), row.id);
  return { ok: true };
}

export interface FriendView {
  handle: string;
  publicKey: string;
  url: string;
  displayName: string | null;
  scope: string[];
  presence: Presence;
}

/** Accepted friends of `key` (either direction), with their presence + scope. */
export function listFriends(db: DB, key: string, now = Date.now()): FriendView[] {
  const rows = db
    .prepare(
      `SELECT f.scope,
              CASE WHEN f.requester_key = ? THEN f.addressee_key ELSE f.requester_key END AS other_key
         FROM friendship f
        WHERE f.status = 'accepted' AND (f.requester_key = ? OR f.addressee_key = ?)`,
    )
    .all(key, key, key) as { scope: string; other_key: string }[];

  const out: FriendView[] = [];
  for (const r of rows) {
    const inst = getInstanceByKey(db, r.other_key);
    if (!inst) continue;
    out.push({
      handle: inst.handle,
      publicKey: inst.public_key,
      url: inst.url,
      displayName: inst.display_name,
      scope: safeScope(r.scope),
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
      "SELECT scope, requester_key AS other_key FROM friendship WHERE addressee_key = ? AND status = 'pending'",
    )
    .all(key) as { scope: string; other_key: string }[];
  const outgoing = db
    .prepare(
      "SELECT scope, addressee_key AS other_key FROM friendship WHERE requester_key = ? AND status = 'pending'",
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
