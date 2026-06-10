import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { createApp } from "./server.ts";
import { canonicalString, generateKeypair, type Signer } from "./crypto.ts";
import { clearRateLimit } from "./ratelimit.ts";

function app() {
  clearRateLimit(); // isolate each test from the shared IP bucket
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

  // Both now see each other as friends, with directional scopes.
  const arinFriends = (await readJson(await call(a, arin, "GET", "/v1/friends"))).friends;
  assert.equal(arinFriends.length, 1);
  assert.equal(arinFriends[0].handle, "sam");
  assert.deepEqual(arinFriends[0].iShareWith, ["calendar"]); // arin's request scope
  assert.deepEqual(arinFriends[0].sharesWithMe, ["calendar", "pmc"]); // sam's grant

  const samFriends = (await readJson(await call(a, sam, "GET", "/v1/friends"))).friends;
  assert.equal(samFriends.length, 1);
  assert.equal(samFriends[0].handle, "arin");
  assert.deepEqual(samFriends[0].iShareWith, ["calendar", "pmc"]);
  assert.deepEqual(samFriends[0].sharesWithMe, ["calendar"]);
});

test("cache: owner pushes, authorized friend reads, others are blocked", async () => {
  const a = app();
  const arin = generateKeypair();
  const sam = generateKeypair();
  const eve = generateKeypair();
  await call(a, arin, "POST", "/v1/register", { handle: "arin", url: "https://a.example" });
  await call(a, sam, "POST", "/v1/register", { handle: "sam", url: "https://s.example" });
  await call(a, eve, "POST", "/v1/register", { handle: "eve", url: "https://e.example" });

  // Arin shares calendar with Sam; Sam accepts.
  await call(a, arin, "POST", "/v1/friends/request", { handle: "sam", scope: ["calendar"] });
  await call(a, sam, "POST", "/v1/friends/respond", { handle: "arin", accept: true, scope: [] });

  // Arin pushes a cached calendar payload.
  const put = await call(a, arin, "PUT", "/v1/cache/calendar", { payload: { items: [1, 2, 3] } });
  assert.equal(put.status, 200);

  // Sam (granted calendar) can read it.
  const ok = await call(a, sam, "GET", "/v1/cache/arin/calendar");
  assert.equal(ok.status, 200);
  assert.deepEqual((await readJson(ok)).payload, { items: [1, 2, 3] });

  // Sam was not granted pmc → 403.
  const wrongScope = await call(a, sam, "GET", "/v1/cache/arin/pmc");
  assert.equal(wrongScope.status, 403);

  // Eve is not a friend → 403.
  const stranger = await call(a, eve, "GET", "/v1/cache/arin/calendar");
  assert.equal(stranger.status, 403);
});

test("key rotation moves the identity across instance, friends, and cache", async () => {
  const a = app();
  const arin = generateKeypair();
  const sam = generateKeypair();
  const arin2 = generateKeypair(); // arin's new key
  await call(a, arin, "POST", "/v1/register", { handle: "arin", url: "https://a.example" });
  await call(a, sam, "POST", "/v1/register", { handle: "sam", url: "https://s.example" });
  await call(a, arin, "POST", "/v1/friends/request", { handle: "sam", scope: ["calendar"] });
  await call(a, sam, "POST", "/v1/friends/respond", { handle: "arin", accept: true, scope: [] });

  const rot = await call(a, arin, "POST", "/v1/rotate", { newKey: arin2.publicKey });
  assert.equal(rot.status, 200);

  // The old key is gone; the new key owns the handle and the friendship.
  const oldResolve = await call(a, sam, "GET", "/v1/resolve/arin");
  assert.equal((await readJson(oldResolve)).publicKey, arin2.publicKey);
  const friends = (await readJson(await call(a, arin2, "GET", "/v1/friends"))).friends;
  assert.equal(friends.length, 1);
  assert.equal(friends[0].handle, "sam");
});

test("account deletion removes the instance", async () => {
  const a = app();
  const arin = generateKeypair();
  await call(a, arin, "POST", "/v1/register", { handle: "arin", url: "https://a.example" });
  const del = await call(a, arin, "DELETE", "/v1/account");
  assert.equal(del.status, 200);
  const gone = await call(a, arin, "GET", "/v1/resolve/arin");
  assert.equal(gone.status, 404);
});

test("rate limiting kicks in after the burst capacity", async () => {
  const a = app();
  const arin = generateKeypair();
  await call(a, arin, "POST", "/v1/register", { handle: "arin", url: "https://a.example" });
  let limited = false;
  for (let i = 0; i < 130; i++) {
    const r = await call(a, arin, "GET", "/v1/resolve/arin");
    if (r.status === 429) {
      limited = true;
      break;
    }
  }
  assert.equal(limited, true);
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

// ---- social: kudos + comments --------------------------------------------

/** Register three handles; arin and sam become friends, eve stays a stranger. */
async function socialSetup(a: ReturnType<typeof app>) {
  const arin = generateKeypair();
  const sam = generateKeypair();
  const eve = generateKeypair();
  await call(a, arin, "POST", "/v1/register", { handle: "arin", url: "https://a.example" });
  await call(a, sam, "POST", "/v1/register", { handle: "sam", url: "https://s.example" });
  await call(a, eve, "POST", "/v1/register", { handle: "eve", url: "https://e.example" });
  await call(a, arin, "POST", "/v1/friends/request", { handle: "sam", scope: ["activities"] });
  await call(a, sam, "POST", "/v1/friends/respond", { handle: "arin", accept: true, scope: ["activities"] });
  return { arin, sam, eve };
}

test("kudos: friend toggles on and off; strangers and self are blocked", async () => {
  const a = app();
  const { arin, sam, eve } = await socialSetup(a);
  const ref = "2026-06-09:42";

  // Sam kudos's Arin's activity.
  const on = await readJson(await call(a, sam, "POST", "/v1/social/kudos", { handle: "arin", ref }));
  assert.equal(on.kudosed, true);
  assert.equal(on.count, 1);

  // Toggling again removes it.
  const off = await readJson(await call(a, sam, "POST", "/v1/social/kudos", { handle: "arin", ref }));
  assert.equal(off.kudosed, false);
  assert.equal(off.count, 0);

  // A stranger is rejected; so is self-kudos.
  const stranger = await call(a, eve, "POST", "/v1/social/kudos", { handle: "arin", ref });
  assert.equal(stranger.status, 403);
  const self = await call(a, arin, "POST", "/v1/social/kudos", { handle: "arin", ref });
  assert.equal(self.status, 400);
});

test("comments: friends and the owner post; author or owner deletes", async () => {
  const a = app();
  const { arin, sam, eve } = await socialSetup(a);
  const ref = "2026-06-09:42";

  const c1 = await readJson(
    await call(a, sam, "POST", "/v1/social/comment", { handle: "arin", ref, body: "Nice run!" }),
  );
  assert.equal(c1.ok, true);
  // The owner can reply on their own activity.
  const c2 = await call(a, arin, "POST", "/v1/social/comment", { handle: "arin", ref, body: "Thanks!" });
  assert.equal(c2.status, 200);
  // A stranger cannot comment.
  const blocked = await call(a, eve, "POST", "/v1/social/comment", { handle: "arin", ref, body: "hi" });
  assert.equal(blocked.status, 403);
  // Empty and oversized bodies are rejected.
  const empty = await call(a, sam, "POST", "/v1/social/comment", { handle: "arin", ref, body: "  " });
  assert.equal(empty.status, 400);
  const huge = await call(a, sam, "POST", "/v1/social/comment", {
    handle: "arin", ref, body: "x".repeat(1001),
  });
  assert.equal(huge.status, 400);

  // The thread is visible to owner and friend, with authorship flags.
  const thread = await readJson(await call(a, sam, "GET", `/v1/social/arin/${ref}`));
  assert.equal(thread.comments.length, 2);
  assert.equal(thread.comments[0].handle, "sam");
  assert.equal(thread.comments[0].mine, true);
  assert.equal(thread.comments[1].handle, "arin");
  assert.equal(thread.comments[1].mine, false);

  // Eve can't read it; Sam can't delete Arin's comment; the owner can delete Sam's.
  const noRead = await call(a, eve, "GET", `/v1/social/arin/${ref}`);
  assert.equal(noRead.status, 403);
  const arinCommentId = thread.comments[1].id;
  const notYours = await call(a, sam, "DELETE", `/v1/social/comment/${arinCommentId}`);
  assert.equal(notYours.status, 404);
  const ownerDeletes = await call(a, arin, "DELETE", `/v1/social/comment/${thread.comments[0].id}`);
  assert.equal(ownerDeletes.status, 200);
  const after = await readJson(await call(a, arin, "GET", `/v1/social/arin/${ref}`));
  assert.equal(after.comments.length, 1);
});

test("social summary: batch counts with per-item authorization", async () => {
  const a = app();
  const { arin, sam, eve } = await socialSetup(a);
  await call(a, sam, "POST", "/v1/social/kudos", { handle: "arin", ref: "d:1" });
  await call(a, sam, "POST", "/v1/social/comment", { handle: "arin", ref: "d:1", body: "go" });

  // Sam sees counts (and that the kudos is his); his own activity shows zeros.
  const res = await readJson(
    await call(a, sam, "POST", "/v1/social/summary", {
      items: [
        { handle: "arin", ref: "d:1" },
        { handle: "sam", ref: "d:9" },
        { handle: "nobody", ref: "d:1" },
      ],
    }),
  );
  assert.deepEqual(res.counts[0], { kudos: 1, comments: 1, mine: true });
  assert.deepEqual(res.counts[1], { kudos: 0, comments: 0, mine: false });
  assert.deepEqual(res.counts[2], { kudos: 0, comments: 0, mine: false });

  // The owner sees the same counts, not flagged as theirs.
  const own = await readJson(
    await call(a, arin, "POST", "/v1/social/summary", { items: [{ handle: "arin", ref: "d:1" }] }),
  );
  assert.deepEqual(own.counts[0], { kudos: 1, comments: 1, mine: false });

  // A stranger gets zeros, not an error (no existence leak).
  const stranger = await readJson(
    await call(a, eve, "POST", "/v1/social/summary", { items: [{ handle: "arin", ref: "d:1" }] }),
  );
  assert.deepEqual(stranger.counts[0], { kudos: 0, comments: 0, mine: false });
});

test("deleting an account removes its reactions and comments", async () => {
  const a = app();
  const { arin, sam } = await socialSetup(a);
  await call(a, sam, "POST", "/v1/social/kudos", { handle: "arin", ref: "d:1" });
  await call(a, sam, "POST", "/v1/social/comment", { handle: "arin", ref: "d:1", body: "hey" });

  await call(a, sam, "DELETE", "/v1/account");

  const thread = await readJson(await call(a, arin, "GET", "/v1/social/arin/d:1"));
  assert.equal(thread.kudos.length, 0);
  assert.equal(thread.comments.length, 0);
});
