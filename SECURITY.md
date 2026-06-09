# Security Policy

The directory is an internet-facing, multi-tenant service that brokers trust
between self-hosted instances — so security reports matter a lot here. Thank you
for reporting responsibly.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub's
[Report a vulnerability](https://github.com/arin-jaff/TrainingGeeks-Directory/security/advisories/new)
flow (Security tab → Advisories).

Include, where possible:

- A description of the issue and its impact.
- Steps to reproduce or a proof of concept.
- The affected version/commit.

## Especially in scope

- **Signature/identity bypass** — accepting an unsigned or wrongly-signed
  mutating request, or impersonating another instance's public key.
- **Replay attacks** — re-submitting a captured signed request.
- **Handle squatting / takeover** — claiming or hijacking another instance's
  handle or public key.
- **Authorization leaks** — exposing an instance's URL, presence, friend graph,
  or (Phase 2) cached shared data to someone not authorized for it.
- **Injection** in any directory query or stored field.

Operational hardening of a given deployment (TLS, rate limiting, the reverse
proxy / tunnel) is the operator's responsibility, but insecure defaults are fair
game to report.
