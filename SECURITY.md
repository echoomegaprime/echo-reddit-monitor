# Security Policy

## Supported Versions

Only the latest deployed revision of `echo-reddit-monitor` receives security fixes.

## Reporting a Vulnerability

Do not open a public GitHub issue for a suspected vulnerability. Email **security@echo-ept.com**.

## Fixed This Pass

### Unauthenticated Worker — every route was public (fixed)

The entire service had zero authentication. `GET /health`, `/stats`, `/monitor/list`, `/posts`,
`/digest`, `/alerts` exposed the collected Reddit intelligence data (including keyword
monitoring around cybersecurity/crypto/oil-and-gas topics) to anyone; `POST /monitor/add`,
`/monitor/remove`, `/scan`, `/digest/generate`, `/forge-sync` let anyone reconfigure monitoring
targets or trigger expensive operations (Reddit API calls, Workers AI inference, D1 writes) —
a cost-abuse and data-integrity vector, not just a confidentiality one.

Fixed with a fail-closed auth middleware requiring `X-Echo-API-Key` (constant-time comparison,
`timingSafeEqual`) on every route except the bare `/` liveness check. An unconfigured
`ECHO_API_KEY` returns `503`, never an open door. Verified with a 14-test suite proving all
four states (missing key → 401, wrong key → 401, unconfigured key → 503, correct key → 200
positive control) and confirmed the guard is a real regression check by tamper-testing (bypassed
middleware → 4 tests correctly fail; restored → all 14 pass again).

Set the key via `wrangler secret put ECHO_API_KEY` (same channel as the existing
`REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` secrets — never add it to `wrangler.toml`'s `[vars]`,
which is plaintext).

### `npm audit` — resolved to 0 vulnerabilities

`hono` (high, direct production dependency) fixed via `npm audit fix`. The remaining 6 findings
(`undici`, `ws`, `miniflare`, `esbuild`, `sharp`, `wrangler` itself) were all `wrangler`'s own
dev-only toolchain — resolved by bumping `wrangler` 3.99 → 4.120 (`npm audit fix --force`) and
`@cloudflare/workers-types` to the matching v5 peer range. Verified the bump didn't break
anything via `wrangler deploy --dry-run` (bindings resolve correctly, no config errors).

## Design Notes

- No customer-facing surface — this is an internal ECHO intelligence-gathering service; auth is
  a single shared service key, not per-user.
- Reddit OAuth2 credentials (`REDDIT_CLIENT_ID`/`SECRET`/`USERNAME`/`PASSWORD`) are Worker
  secrets, never committed, never logged (structured `log()` calls only include non-secret
  metadata like username for token-acquisition audit trails, never the password or token itself).
- `timingSafeEqual` always walks a length-padded buffer rather than short-circuiting on length
  mismatch, so key length can't be recovered via timing.
