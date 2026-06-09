import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { MIGRATIONS } from "./migrations.ts";

export type DB = DatabaseSync;

const DEFAULT_DB_PATH = join(process.cwd(), "data", "directory.db");

/** Apply any not-yet-applied migrations in id order. Idempotent. */
export function runMigrations(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);

  const applied = new Set(
    (db.prepare("SELECT id FROM _migrations").all() as { id: number }[]).map(
      (r) => r.id,
    ),
  );
  const insert = db.prepare("INSERT INTO _migrations (id, name) VALUES (?, ?)");

  for (const m of [...MIGRATIONS].sort((a, b) => a.id - b.id)) {
    if (applied.has(m.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      insert.run(m.id, m.name);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${m.id} (${m.name}) failed: ${(err as Error).message}`);
    }
  }
}

/** Open a database, run migrations, and return it. ':memory:' for tests. */
export function openDb(path: string = process.env.TG_DIRECTORY_DB || DEFAULT_DB_PATH): DB {
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  runMigrations(db);
  return db;
}
