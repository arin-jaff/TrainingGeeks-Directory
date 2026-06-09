import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { openDb } from "./db.ts";

export const VERSION = "0.1.0";

/**
 * Build the directory app. The DB is injected so tests can pass an in-memory
 * one. Routes are mounted here as they are implemented (see PLAN.md §Roadmap).
 */
export function createApp(db = openDb()) {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({ ok: true, service: "traininggeeks-directory", version: VERSION }),
  );

  // Phase 1 routes (register / heartbeat / resolve / friends) mount here.
  void db;

  return app;
}

// Only start a listener when run directly, not when imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 4000);
  serve({ fetch: createApp().fetch, port });
  console.log(`traininggeeks-directory v${VERSION} listening on :${port}`);
}
