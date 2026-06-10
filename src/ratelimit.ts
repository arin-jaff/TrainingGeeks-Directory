import type { MiddlewareHandler } from "hono";

interface Bucket {
  tokens: number;
  last: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Simple in-memory token-bucket rate limiter, keyed by client IP. Cheap abuse
 * protection that runs before signature verification. Behind Cloudflare the
 * real client IP is in cf-connecting-ip / x-forwarded-for.
 */
export function rateLimit(opts: {
  capacity: number;
  refillPerSec: number;
}): MiddlewareHandler {
  return async (c, next) => {
    const ip = (
      c.req.header("cf-connecting-ip") ||
      c.req.header("x-forwarded-for")?.split(",")[0] ||
      "local"
    ).trim();
    const now = Date.now();
    const b = buckets.get(ip) ?? { tokens: opts.capacity, last: now };
    b.tokens = Math.min(opts.capacity, b.tokens + ((now - b.last) / 1000) * opts.refillPerSec);
    b.last = now;
    if (b.tokens < 1) {
      buckets.set(ip, b);
      return c.json({ error: "rate limited" }, 429);
    }
    b.tokens -= 1;
    buckets.set(ip, b);
    await next();
  };
}

/** Test seam: reset all buckets. */
export function clearRateLimit(): void {
  buckets.clear();
}
