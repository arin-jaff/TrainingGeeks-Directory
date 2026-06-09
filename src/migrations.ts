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
];
