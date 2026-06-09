import { Hono } from "hono";
import { openDb } from "./db.ts";
import { v1Routes } from "./routes.ts";

export const VERSION = "0.1.0";

/**
 * Build the directory app. The DB is injected so tests can pass an in-memory
 * one. See PLAN.md §API for the route surface.
 */
export function createApp(db = openDb()) {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({ ok: true, service: "traininggeeks-directory", version: VERSION }),
  );

  app.route("/v1", v1Routes(db));

  return app;
}
