# TrainingGeeks Directory — Agent Conventions

Read `PLAN.md` before doing any work. This repo is the coordination layer for
the [TrainingGeeks](https://github.com/arin-jaff/TrainingGeeks) app; the two are
designed together (see PLAN.md for how the app's client module and this server
fit).

## Non-negotiable rules (always apply)

1. **Modular commits.** One focused commit (or tight set) per step/feature —
   never a single mega-commit. Keep each commit independently reviewable and,
   where possible, demoable. Map work to the roadmap in `PLAN.md`.

2. **Author is arin-jaff only — never credit Claude.** Do **not** add
   `Co-Authored-By: Claude`, "Generated with Claude Code", or any AI attribution
   to commit messages, PR bodies, or code comments. Commits are authored solely
   by Arin Jaff.

3. **Stay lean.** This is an API coordination layer, not a platform. Prefer the
   Node standard library (`node:sqlite`, `node:crypto`, `node:http`). Hono is
   the only framework; justify anything else. No database server, no ORM.

4. **The wire protocol is a contract.** Federation endpoints are versioned
   (`/v1/...`) and consumed by independently-hosted, possibly-forked instances.
   Never break an existing versioned endpoint — add a new version. Keep request
   and response shapes documented in `PLAN.md`.

5. **Security is the product.** Every mutating request is Ed25519-signed and
   verified with replay protection. Never add a state-changing endpoint without
   it. Never hand-roll crypto — use `node:crypto`. Store the minimum needed for
   coordination; a user's actual training data stays on their instance.

6. **No emojis in code or output.** Clean, sharp, plain text.

## Stack quick reference

Node 24 · Hono · `node:sqlite` (embedded SQL migrations, same pattern as the
app) · `node:crypto` Ed25519 · TypeScript via `tsx` · `node:test`.
