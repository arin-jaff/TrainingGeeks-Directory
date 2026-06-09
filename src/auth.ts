import type { MiddlewareHandler } from "hono";
import { verifySignature } from "./crypto.ts";

/** Context variables set by the signature middleware for downstream handlers. */
export type AuthVars = {
  /** Verified base64url public key of the caller (their identity). */
  signerKey: string;
  /** Raw request body, already read (handlers should parse from this). */
  rawBody: string;
};

/**
 * Require a valid Ed25519 signature over (method, path, timestamp, body).
 * Reads the body once and stashes it so handlers don't re-read the stream.
 * The signed path is the URL pathname (no query string).
 */
export function requireSignature(): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    const key = c.req.header("X-TG-Key");
    const timestamp = c.req.header("X-TG-Timestamp");
    const signature = c.req.header("X-TG-Signature");
    const body = await c.req.text();
    const path = new URL(c.req.url).pathname;

    const ok = verifySignature({
      key,
      method: c.req.method,
      path,
      timestamp,
      body,
      signature,
    });
    if (!ok) return c.json({ error: "invalid or missing signature" }, 401);

    c.set("signerKey", key!);
    c.set("rawBody", body);
    await next();
  };
}

/** Parse the already-read raw body as JSON, or return {} on empty/invalid. */
export function jsonBody<T = Record<string, unknown>>(raw: string): T {
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}
