import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalString,
  generateKeypair,
  SKEW_MS,
  verifySignature,
} from "./crypto.ts";

function signed(
  signer: ReturnType<typeof generateKeypair>,
  method: string,
  path: string,
  body: string,
  timestamp: number,
) {
  return {
    key: signer.publicKey,
    method,
    path,
    body,
    timestamp: String(timestamp),
    signature: signer.sign(canonicalString(method, path, timestamp, body)),
  };
}

// CONFORMANCE VECTOR — the on-the-wire canonical string format. Forks and the
// app MUST produce this exact string, or signatures won't interoperate. Do not
// change without bumping the protocol version. See CONFORMANCE.md.
test("canonical string matches the frozen conformance vector", () => {
  const s = canonicalString("POST", "/v1/register", 1700000000000, '{"handle":"arin"}');
  assert.equal(
    s,
    "POST\n/v1/register\n1700000000000\n" +
      "fa36b78cd8ea6656079d4c5353632e3f2c02abe436de7c6065afcedb8b539406",
  );
});

test("a correctly signed request verifies", () => {
  const s = generateKeypair();
  const now = 1_000_000_000_000;
  const req = signed(s, "POST", "/v1/register", '{"handle":"arin"}', now);
  assert.equal(verifySignature({ ...req, now }), true);
});

test("a tampered body fails", () => {
  const s = generateKeypair();
  const now = 1_000_000_000_000;
  const req = signed(s, "POST", "/v1/register", '{"handle":"arin"}', now);
  assert.equal(
    verifySignature({ ...req, body: '{"handle":"mallory"}', now }),
    false,
  );
});

test("a different path fails (signature is path-bound)", () => {
  const s = generateKeypair();
  const now = 1_000_000_000_000;
  const req = signed(s, "POST", "/v1/register", "", now);
  assert.equal(verifySignature({ ...req, path: "/v1/heartbeat", now }), false);
});

test("a stale timestamp outside the skew window fails (replay guard)", () => {
  const s = generateKeypair();
  const now = 1_000_000_000_000;
  const req = signed(s, "POST", "/v1/heartbeat", "", now);
  assert.equal(verifySignature({ ...req, now: now + SKEW_MS + 1 }), false);
  assert.equal(verifySignature({ ...req, now: now + SKEW_MS - 1 }), true);
});

test("another key's signature does not verify against this key", () => {
  const a = generateKeypair();
  const b = generateKeypair();
  const now = 1_000_000_000_000;
  const req = signed(a, "POST", "/v1/register", "", now);
  assert.equal(verifySignature({ ...req, key: b.publicKey, now }), false);
});

test("missing pieces fail closed", () => {
  const s = generateKeypair();
  const now = 1_000_000_000_000;
  const req = signed(s, "GET", "/v1/friends", "", now);
  assert.equal(verifySignature({ ...req, key: undefined, now }), false);
  assert.equal(verifySignature({ ...req, signature: undefined, now }), false);
  assert.equal(verifySignature({ ...req, timestamp: undefined, now }), false);
});
