import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";

test("migrations create the v1 schema", () => {
  const db = openDb(":memory:");
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  assert.ok(tables.includes("instance"));
  assert.ok(tables.includes("friendship"));
});

test("an instance can be registered and read back", () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO instance (handle, public_key, url) VALUES (?, ?, ?)",
  ).run("arin", "PUBKEY_BASE64", "https://traininggeeks.arinjaff.com");
  const row = db
    .prepare("SELECT handle, url FROM instance WHERE public_key = ?")
    .get("PUBKEY_BASE64") as { handle: string; url: string };
  assert.equal(row.handle, "arin");
  assert.equal(row.url, "https://traininggeeks.arinjaff.com");
});
