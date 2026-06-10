# Protocol conformance (for forks & alternate clients)

Anything that talks to the directory — the TrainingGeeks app, a fork, or a new
client — must speak the v1 protocol exactly, or signatures won't verify and
authorization won't work. This file is the spec + test vectors. The matching
automated check lives in `src/crypto.test.ts` ("conformance vector").

## 1. Identity

Each instance generates an **Ed25519** keypair once. Its identity is the raw
public key, base64url-encoded (the JWK `x` value). The private key never leaves
the instance.

## 2. Request signing (every mutating call, and authenticated reads)

Build the **canonical string**:

```
METHOD\nPATH\nTIMESTAMP_MS\nSHA256_HEX(body)
```

- `METHOD` — uppercase HTTP method (`GET`, `POST`, `PUT`, `DELETE`).
- `PATH` — the URL pathname only, no query string (e.g. `/v1/resolve/arin`).
- `TIMESTAMP_MS` — current time in milliseconds since epoch.
- `SHA256_HEX(body)` — lowercase hex SHA-256 of the raw request body
  (empty string for GET/DELETE).

Sign it with Ed25519 (detached) and send these headers:

| Header | Value |
| --- | --- |
| `X-TG-Key` | base64url raw public key |
| `X-TG-Timestamp` | the `TIMESTAMP_MS` used above |
| `X-TG-Signature` | base64 Ed25519 signature of the canonical string |

The server rejects timestamps outside a **±5 minute** window (replay guard).

### Frozen test vector

```
method   = POST
path     = /v1/register
ts       = 1700000000000
body     = {"handle":"arin"}

canonical string =
POST\n/v1/register\n1700000000000\nfa36b78cd8ea6656079d4c5353632e3f2c02abe436de7c6065afcedb8b539406
```

(`fa36b78c…539406` is `sha256('{"handle":"arin"}')`.) If your client produces a
different canonical string for these inputs, it is non-conformant.

## 3. Endpoints (v1)

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | Liveness |
| `POST /v1/register` | signed | Claim/update handle + URL |
| `POST /v1/heartbeat` | signed | Presence |
| `GET /v1/resolve/:handle` | signed | Handle → key, URL, presence |
| `POST /v1/friends/request` | signed | Request a friend at a scope |
| `POST /v1/friends/respond` | signed | Accept/decline at a scope |
| `GET /v1/friends` | signed | Friends + pending + directional scopes |
| `PUT /v1/cache/:scope` | signed | Push offline-viewable cache |
| `GET /v1/cache/:handle/:scope` | signed | Read a friend's cache (authorized) |
| `POST /v1/rotate` | signed (old key) | Rotate identity key |
| `DELETE /v1/account` | signed | Delete the instance |

Authorization for third-party reads is the friend graph + the owner's
directional scope. Unknown response fields must be ignored by clients.

## 4. Limits

- Requests are IP rate-limited (HTTP 429 when exceeded).
- Cache payloads are capped (HTTP 413 when exceeded).
