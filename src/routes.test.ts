import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { createApp } from "./server.ts";
import { canonicalString, generateKeypair, type Signer } from "./crypto.ts";

function app() {
  return createApp(openDb(":memory:"));
}

/** Issue a signed request against the in-memory app, mirroring a real client. */
function call(
  a: ReturnType<typeof app>,
  signer: Signer,
  method: string,
  path: string,
  body?: unknown,
) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const ts = Date.now();
  const headers: Record<string, string> = {
    "X-TG-Key": signer.publicKey,
    "X-TG-Timestamp": String(ts),
    "X-TG-Signature": signer.sign(canonicalString(method, path, ts, raw)),
  };
  if (raw) headers["Content-Type"] = "application/json";
  return a.request(path, { method, headers, body: raw || undefined });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readJson = (res: Response): Promise<any> => res.json() as Promise<any>;

test("unsigned requests are rejected", async () => {
  const a = app();
  const res = await a.request("/v1/friends");
  assert.equal(res.status, 401);
});

test("register, resolve, and presence", async () => {
  const a = app();
  const arin = generateKeypair();

  const reg = await call(a, arin, "POST", "/v1/register", {
    handle: "Arin",
    url: "https://traininggeeks.arinjaff.com",
    displayName: "Arin",
  });
  assert.equal(reg.status, 200);
  assert.equal((await readJson(reg)).handle, "arin"); // normalized lowercase

  const before = await call(a, arin, "GET", "/v1/resolve/arin");
  assert.equal((await readJson(before)).presence.online, false);

  await call(a, arin, "POST", "/v1/heartbeat");
  const after = await call(a, arin, "GET", "/v1/resolve/arin");
  const body = await readJson(after);
  assert.equal(body.presence.online, true);
  assert.equal(body.url, "https://traininggeeks.arinjaff.com");
  assert.equal(body.publicKey, arin.publicKey);
});

test("a handle cannot be taken by another key", async () => {
  const a = app();
  const arin = generateKeypair();
  const mallory = generateKeypair();
  await call(a, arin, "POST", "/v1/register", {
    handle: "arin",
    url: "https://a.example",
  });
  const res = await call(a, mallory, "POST", "/v1/register", {
    handle: "arin",
    url: "https://m.example",
  });
  assert.equal(res.status, 409);
});

test("heartbeat before registering is rejected", async () => {
  const a = app();
  const ghost = generateKeypair();
  const res = await call(a, ghost, "POST", "/v1/heartbeat");
  assert.equal(res.status, 404);
});

test("full friend request → accept flow", async () => {
  const a = app();
  const arin = generateKeypair();
  const sam = generateKeypair();
  await call(a, arin, "POST", "/v1/register", { handle: "arin", url: "https://a.example" });
  await call(a, sam, "POST", "/v1/register", { handle: "sam", url: "https://s.example" });

  // Arin requests Sam.
  const req = await call(a, arin, "POST", "/v1/friends/request", {
    handle: "sam",
    scope: ["calendar"],
  });
  assert.equal((await readJson(req)).status, "pending");

  // Sam sees it incoming.
  const samView = await readJson(await call(a, sam, "GET", "/v1/friends"));
  assert.equal(samView.incoming.length, 1);
  assert.equal(samView.incoming[0].handle, "arin");
  assert.equal(samView.friends.length, 0);

  // Sam accepts, granting a scope.
  const resp = await call(a, sam, "POST", "/v1/friends/respond", {
    handle: "arin",
    accept: true,
    scope: ["calendar", "pmc"],
  });
  assert.equal((await readJson(resp)).status, "accepted");

  // Both now see each other as friends.
  const arinFriends = (await readJson(await call(a, arin, "GET", "/v1/friends"))).friends;
  assert.equal(arinFriends.length, 1);
  assert.equal(arinFriends[0].handle, "sam");
  assert.deepEqual(arinFriends[0].scope, ["calendar", "pmc"]);

  const samFriends = (await readJson(await call(a, sam, "GET", "/v1/friends"))).friends;
  assert.equal(samFriends.length, 1);
  assert.equal(samFriends[0].handle, "arin");
});

test("declining leaves no friendship", async () => {
  const a = app();
  const arin = generateKeypair();
  const sam = generateKeypair();
  await call(a, arin, "POST", "/v1/register", { handle: "arin", url: "https://a.example" });
  await call(a, sam, "POST", "/v1/register", { handle: "sam", url: "https://s.example" });
  await call(a, arin, "POST", "/v1/friends/request", { handle: "sam" });
  await call(a, sam, "POST", "/v1/friends/respond", { handle: "arin", accept: false });

  const arinFriends = (await readJson(await call(a, arin, "GET", "/v1/friends"))).friends;
  assert.equal(arinFriends.length, 0);
});
