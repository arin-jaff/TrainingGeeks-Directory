# Protocol versioning policy

The directory's HTTP API is a **contract** consumed by independently-hosted, and
possibly forked, TrainingGeeks instances. Different instances run different
versions of the app and this server, so the wire protocol must stay stable.

## The rule

The API is versioned by path prefix: **`/v1/...`**.

- **Never make a breaking change to an existing version.** A breaking change is
  anything that could make an older client fail: removing or renaming a field,
  changing a field's type or meaning, tightening validation, changing the
  signing format, or removing an endpoint.
- **Additive changes are allowed within a version**: new optional request
  fields, new response fields, new endpoints. Clients must ignore unknown
  response fields.
- **Breaking changes require a new version** (`/v2/...`), served alongside `/v1`
  until clients have migrated.

## Frozen surface (v1)

- **Signing format** — the canonical string
  `METHOD\nPATH\nTIMESTAMP_MS\nSHA256_HEX(body)`, Ed25519 detached signature,
  headers `X-TG-Key` (base64url raw public key), `X-TG-Timestamp`,
  `X-TG-Signature` (base64). ±5 minute skew window. See [CONFORMANCE.md].
- **Identity** — an instance is identified by its Ed25519 public key; the handle
  is a mutable alias owned by the first key to claim it (trust on first use).
- **Endpoints** — `register`, `heartbeat`, `resolve/:handle`,
  `friends/request`, `friends/respond`, `friends`, `cache/:scope` (PUT),
  `cache/:handle/:scope` (GET), `rotate`, `account` (DELETE), and the social
  surface added in 0.2: `social/kudos` (POST), `social/comment` (POST),
  `social/comment/:id` (DELETE), `social/:handle/:ref` (GET),
  `social/summary` (POST).

## Deprecation

When `/v2` ships, `/v1` is supported for a documented window (minimum: until the
canonical app and demo have moved). Deprecations are announced in the changelog
and this file.
