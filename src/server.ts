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

  // A human landing at the bare hostname gets pointed somewhere useful
  // instead of a 404. The API itself lives under /v1.
  app.get("/", (c) =>
    c.json({
      service: "traininggeeks-directory",
      version: VERSION,
      docs: "https://github.com/arin-jaff/TrainingGeeks-Directory",
      health: "/health",
      api: "/v1 (Ed25519-signed; see CONFORMANCE.md)",
    }),
  );

  app.get("/health", (c) =>
    c.json({ ok: true, service: "traininggeeks-directory", version: VERSION }),
  );

  app.route("/v1", v1Routes(db));

  return app;
}
