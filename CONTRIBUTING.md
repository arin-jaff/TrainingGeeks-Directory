# Contributing to TrainingGeeks Directory

Thanks for your interest. This is the coordination layer for
[TrainingGeeks](https://github.com/arin-jaff/TrainingGeeks); contributions that
keep it **lean, secure, and protocol-stable** are very welcome.

## Getting set up

Requires **Node.js 24+** (uses the built-in `node:sqlite` and `node:crypto`).

```bash
git clone https://github.com/arin-jaff/TrainingGeeks-Directory.git
cd TrainingGeeks-Directory
npm install
npm run dev      # http://localhost:4000
```

## Before you open a PR

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test
```

## Conventions

- **Stay lean.** This is an API coordination layer, not a platform. Prefer the
  standard library (`node:sqlite`, `node:crypto`, `node:http`) and resist adding
  dependencies. Hono is the one framework; justify anything beyond it.
- **The wire protocol is a contract.** Self-hosted TrainingGeeks instances —
  including forks on older versions — depend on the federation API being stable
  and **versioned** (`/v1/...`). Never make a breaking change to an existing
  versioned endpoint; add a new version instead.
- **Security first.** Every mutating request is signed (Ed25519) and verified.
  Don't add an endpoint that mutates state without signature verification and
  replay protection. Never hand-roll crypto — use `node:crypto`.
- **Share the minimum.** The directory stores only what coordination needs
  (handles, public keys, URLs, presence, friend edges). Don't add columns that
  centralize a user's actual training data unless it's an explicit, opt-in,
  scoped cache (Phase 2) — and document why.
- **Modular commits.** One focused change per commit; keep each independently
  reviewable.

## License

By contributing, you agree your contributions are licensed under
[AGPL-3.0-or-later](LICENSE).
