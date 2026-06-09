import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";

/** Mutating requests must be signed within this clock-skew window (replay guard). */
export const SKEW_MS = 5 * 60 * 1000;

/**
 * The canonical string a client signs and the server reconstructs. Binding the
 * method, path, timestamp, and a hash of the body prevents a captured signature
 * from being replayed against a different request or after the window.
 */
export function canonicalString(
  method: string,
  path: string,
  timestampMs: number | string,
  body: string,
): string {
  const bodyHash = createHash("sha256").update(body ?? "").digest("hex");
  return `${method.toUpperCase()}\n${path}\n${timestampMs}\n${bodyHash}`;
}

/** Rebuild an Ed25519 public KeyObject from its base64url raw key (the JWK `x`). */
export function publicKeyFromBase64url(x: string): KeyObject {
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x },
    format: "jwk",
  });
}

export interface VerifyInput {
  key: string | undefined; // base64url Ed25519 public key (X-TG-Key)
  method: string;
  path: string;
  timestamp: string | undefined; // ms since epoch (X-TG-Timestamp)
  body: string;
  signature: string | undefined; // base64 Ed25519 signature (X-TG-Signature)
  now?: number;
}

/** True only if the signature is valid AND within the skew window. */
export function verifySignature(input: VerifyInput): boolean {
  const { key, method, path, timestamp, body, signature } = input;
  if (!key || !signature || !timestamp) return false;

  const ts = Number(timestamp);
  const now = input.now ?? Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SKEW_MS) return false;

  let pub: KeyObject;
  try {
    pub = publicKeyFromBase64url(key);
  } catch {
    return false;
  }

  const msg = Buffer.from(canonicalString(method, path, ts, body));
  try {
    return edVerify(null, msg, pub, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export interface Signer {
  /** base64url raw public key — this instance's identity. */
  publicKey: string;
  /** Sign a canonical string, returning a base64 signature. */
  sign(message: string): string;
}

/** Generate an Ed25519 keypair. Used by instances at first run and by tests. */
export function generateKeypair(): Signer {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    publicKey: jwk.x,
    sign: (message: string) =>
      edSign(null, Buffer.from(message), privateKey).toString("base64"),
  };
}
