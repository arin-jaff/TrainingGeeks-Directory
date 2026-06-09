# TrainingGeeks Directory — Architecture & Plan

The coordination layer that lets self-hosted [TrainingGeeks](https://github.com/arin-jaff/TrainingGeeks)
instances find each other, friend each other, and (later) view each other's
opted-in training data — reliably, even though the instances themselves are
intermittent and behind NAT.

## 1. Design principles

1. **Data sovereignty.** Training data lives on each user's instance. The
   directory stores only coordination state: handles, public keys, current
   URLs, presence, and the friend graph. (A scoped, opt-in *cache* of shared
   data comes in Phase 2 — strictly the subset a user chooses to publish.)
2. **Lean.** Node stdlib + Hono + `node:sqlite` + `node:crypto`. No DB server,
   no ORM, minimal dependencies.
3. **Pluggable, not mandatory.** The app talks to a directory *interface*. The
   hosted canonical directory is a convenience, not a lock-in; clubs can
   self-host their own, and purists can skip it (pure P2P).
4. **Protocol is a contract.** Versioned (`/v1`) endpoints with stable shapes so
   independently-hosted and forked instances interoperate across versions.
5. **Trust is cryptographic.** Identity is an Ed25519 keypair per instance;
   every mutation is signed and verified with replay protection.

## 2. The two halves

```
   TrainingGeeks app (per user, self-hosted)        TrainingGeeks-Directory (this repo)
   ┌─────────────────────────────────────┐          ┌──────────────────────────────────┐
   │  federation client module           │  signed  │  /v1/register   handle+pubkey+url │
   │   - keypair (Ed25519)                │ ───────► │  /v1/heartbeat  presence          │
   │   - directory client                 │   HTTPS  │  /v1/resolve    handle → peer     │
   │   - federation read API (/api/fed/*) │ ◄─────── │  /v1/friends/*  the friend graph  │
   │   - friends UI (Settings)            │  resolve │  (Phase 2) shared-data cache/relay│
   └─────────────────────────────────────┘          └──────────────────────────────────┘
            ▲     peer-to-peer reads (A fetches B's shared data directly)     │
            └──────────────────────────────────────────────────────────────►─┘
```

The directory is the **rendezvous + presence + friend graph**. Actual data reads
are **peer-to-peer** (instance A calls instance B's federation read API using a
capability the directory helped them exchange). The directory only relays/caches
data in Phase 2, to cover the "friend is offline" case.

## 3. Identity & trust model

- On first run, each instance generates an **Ed25519 keypair** (`node:crypto`).
  The **public key is the identity**; the handle is a friendly alias.
- **Registration is trust-on-first-use:** first instance to claim a handle owns
  it, bound to its public key. Re-registration (e.g. new URL) must be signed by
  the same key.
- **Every mutating request is signed.** Canonical signing string:
  `${method}\n${path}\n${timestampMs}\n${sha256(body)}`, with an Ed25519
  detached signature. Headers: `X-TG-Key` (base64 pubkey), `X-TG-Timestamp`,
  `X-TG-Signature`. The server rejects timestamps outside a ±5-min skew window
  (replay protection) and verifies the signature against `X-TG-Key`.
- **Capability tokens** (friend access) are short, signed grants minted by the
  *data owner's* instance — "key X may read scope S of mine until T" — which the
  friend presents to the owner's federation read API. The directory brokers the
  exchange but never holds a token that reads private data.

## 4. Data model (v1)

`data/directory.db` (`node:sqlite`):

- **instance** — `id, handle (unique), public_key (unique), url, display_name,
  created_at, last_seen`. One row per registered instance.
- **friendship** — `id, requester_key, addressee_key, status
  (pending|accepted|declined), scope (JSON), created_at, updated_at`, unique on
  `(requester_key, addressee_key)`. Directed request that becomes mutual on
  accept; `scope` is what the addressee agreed to share.

Phase 2 adds **shared_cache** — `owner_key, scope, payload (JSON), updated_at` —
the opt-in published subset, so friends can view an owner who is offline.

## 5. API surface (v1)

All mutations require a valid signature (§3). Reads about a third party require
the caller to be an accepted friend.

| Method & path | Purpose |
| --- | --- |
| `GET /health` | Liveness. (implemented) |
| `POST /v1/register` | Upsert this instance's handle, public key, URL, display name. |
| `POST /v1/heartbeat` | Bump `last_seen`; presence. Sent every ~60s while online. |
| `GET /v1/resolve/:handle` | Resolve a handle → `{ pubkey, url, presence }`. |
| `POST /v1/friends/request` | Ask `addressee` to be friends at a requested scope. |
| `POST /v1/friends/respond` | Accept/decline an incoming request; set granted scope. |
| `GET /v1/friends` | List my friends + their presence + agreed scope. |

Presence is derived: `online` if `last_seen` < ~2 min, else `last_seen`
timestamp. Heartbeat history also distinguishes an **always-on** instance from a
**sometimes-on** one.

## 6. Roadmap

**Phase 0 — Repo init (done).** Data model, runnable skeleton (`/health`),
migrations, CI, docs.

**Phase 1 — Coordination core.**
- Server: signature middleware (verify + replay window), `register`,
  `heartbeat`, `resolve`, `friends/{request,respond}`, `friends` list. Tests for
  signing/verification and the friend state machine.
- App module (`src/lib/federation/` in TrainingGeeks): keypair generation +
  storage, a directory client, a Settings "Friends" page (register handle, send/
  accept requests, see presence). Pluggable `TG_DIRECTORY_URL`; unset = P2P/off.

**Phase 2 — Peer reads + offline cache.**
- App: a versioned **federation read API** (`/api/federation/v1/*`) exposing the
  owner's opted-in scopes, gated by capability tokens (reuses the read-only
  rendering + bearer pattern that already exists).
- App: render a friend's shared view inside the app.
- Directory: optional `shared_cache` push/serve so offline friends are viewable;
  optional request relay for instances behind strict NAT.

**Phase 3 — Social surface.** Friend activity feed, kudos/comments,
friends-only leaderboards — all built on the Phase 2 shared-feed primitive.

**Phase 4 — Federation hardening & governance.** Protocol conformance tests for
forks, key rotation/revocation, abuse controls, rate limiting, and a documented
versioning policy.

## 7. Deployment

Runs anywhere Node 24 does. For Arin's setup it can ride the existing Raspberry
Pi + Cloudflare Tunnel as its own systemd service on a separate port, exposed at
a second hostname (e.g. `directory.arinjaff.com → localhost:4000`) — no second
tunnel needed.

> **Caveat:** the directory's job is to be the *reliable* rendezvous. Hosting it
> on a home Pi is fine for bootstrapping a friend group, but once it serves
> people beyond a test circle it should move to an always-on host (a small VPS),
> since a home box rebooting would take the whole network's coordination down.
