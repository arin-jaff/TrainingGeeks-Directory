# TrainingGeeks Directory

[![CI](https://github.com/arin-jaff/TrainingGeeks-Directory/actions/workflows/ci.yml/badge.svg)](https://github.com/arin-jaff/TrainingGeeks-Directory/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D24-43853d?logo=nodedotjs&logoColor=white)

A **lean coordination layer** that lets independently self-hosted
[**TrainingGeeks**](https://github.com/arin-jaff/TrainingGeeks) instances find
each other, become friends, and share training data — without giving up data
ownership.

> Your training data stays on **your** box. The directory only holds what it
> needs to connect people: handles, public keys, current URLs, presence
> (who's online), and the friend graph. Nothing more in v1.

## Why this exists

TrainingGeeks instances are self-hosted and often intermittent (a Raspberry Pi,
a laptop that sleeps). Pure peer-to-peer "view my friend's data" breaks the
moment a friend's box is offline or unreachable behind NAT. This service is the
small, always-on rendezvous point that solves discovery, presence, and (later)
offline viewing — while the actual data still lives on each person's instance.

It is the **directory** half of a two-repo system:

| Repo | Role |
| --- | --- |
| [TrainingGeeks](https://github.com/arin-jaff/TrainingGeeks) | The self-hosted training app. Ships an opt-in **federation client module** that talks to a directory. |
| **TrainingGeeks-Directory** (this repo) | The multi-tenant coordination server the client module talks to. |

## Pluggable by design

The app depends on a directory *interface*, not on this server. So you can:

- **Use the canonical hosted directory** (the frictionless default).
- **Self-host your own** directory for a club/team (this repo, your box).
- **Go pure peer-to-peer** with no directory at all (paste URLs + tokens).

Same open-source code either way — see [PLAN.md](PLAN.md) for the architecture.

## Stack

Deliberately minimal: **Node 24** · [Hono](https://hono.dev) (tiny HTTP) ·
`node:sqlite` (built-in) · `node:crypto` Ed25519 (built-in). No database server,
no heavy framework.

## Quick start

```bash
npm install
npm run dev      # starts on http://localhost:4000
curl localhost:4000/health
```

```bash
npm run typecheck
npm test
```

The SQLite database is created automatically at `data/directory.db` on first run
(override with `TG_DIRECTORY_DB`).

## Status

**Early.** This repo is initialized with the data model and a runnable skeleton.
The Phase 1 endpoints (register / heartbeat / resolve / friends) are next — see
the roadmap in [PLAN.md](PLAN.md).

## License

[AGPL-3.0-or-later](LICENSE) — same as TrainingGeeks. Run it, modify it,
self-host it; if you run a modified version as a network service, share your
source with its users.
