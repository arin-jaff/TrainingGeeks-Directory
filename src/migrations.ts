/**
 * Schema migrations, embedded as string constants (same pattern as the
 * TrainingGeeks app). Append new migrations; never edit an applied one.
 */

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "init",
    sql: /* sql */ `
-- A registered TrainingGeeks instance. Its Ed25519 public key IS its identity;
-- the handle is a human-friendly alias, and url is where peers reach it.
CREATE TABLE instance (
  id INTEGER PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,        -- e.g. "arin"
  public_key TEXT NOT NULL UNIQUE,    -- base64 Ed25519 public key
  url TEXT NOT NULL,                  -- current public HTTPS base URL
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT                      -- last heartbeat; NULL = never
);
CREATE INDEX idx_instance_pubkey ON instance (public_key);

-- A directed friendship: requester asks addressee for access at a given scope.
-- Becomes mutual when accepted. Scope is a JSON list of shareable views.
CREATE TABLE friendship (
  id INTEGER PRIMARY KEY,
  requester_key TEXT NOT NULL,        -- public_key of the asker
  addressee_key TEXT NOT NULL,        -- public_key of the asked
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined
  scope TEXT NOT NULL DEFAULT '[]',   -- JSON: ["calendar","pmc",...]
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (requester_key, addressee_key)
);
CREATE INDEX idx_friendship_addressee ON friendship (addressee_key, status);
CREATE INDEX idx_friendship_requester ON friendship (requester_key, status);
`,
  },
  {
    id: 2,
    name: "directional_scopes",
    // Sharing is per-direction: each side independently chooses what to share.
    // requester_scope = what the requester shares; addressee_scope = what the
    // addressee shares back. The old single `scope` column is left unused.
    sql: /* sql */ `
ALTER TABLE friendship ADD COLUMN requester_scope TEXT NOT NULL DEFAULT '[]';
ALTER TABLE friendship ADD COLUMN addressee_scope TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    id: 3,
    name: "shared_cache",
    // Owners push the opted-in subset they share, so friends can view them
    // while their instance is offline. Authorized reads only (friend graph).
    sql: /* sql */ `
CREATE TABLE shared_cache (
  id INTEGER PRIMARY KEY,
  owner_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  payload TEXT NOT NULL,           -- JSON, as the owner's instance produced it
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_key, scope)
);
CREATE INDEX idx_shared_cache_owner ON shared_cache (owner_key);
`,
  },
  {
    id: 4,
    name: "social",
    // Kudos and comments on shared activities. They live here (not on the
    // owner's instance) so reactions survive the owner being offline and need
    // no extra peer-to-peer surface. activity_ref is an owner-local opaque id
    // ("<date>:<activityId>"); only the friend graph may read or write.
    sql: /* sql */ `
CREATE TABLE reaction (
  id INTEGER PRIMARY KEY,
  owner_key TEXT NOT NULL,            -- whose activity it is
  actor_key TEXT NOT NULL,            -- who gave the kudos
  activity_ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_key, actor_key, activity_ref)
);
CREATE INDEX idx_reaction_activity ON reaction (owner_key, activity_ref);

CREATE TABLE comment (
  id INTEGER PRIMARY KEY,
  owner_key TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  activity_ref TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_comment_activity ON comment (owner_key, activity_ref);
`,
  },
];
