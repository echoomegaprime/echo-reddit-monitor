# Contributing

## Setup

```bash
git clone https://github.com/echoomegaprime/echo-reddit-monitor.git
cd echo-reddit-monitor
npm install
```

## Development loop

```bash
npm run typecheck                       # tsc --noEmit
npm test                                # vitest run
npx wrangler deploy --dry-run           # verify config/bindings without deploying
npm run dev                             # local dev server (wrangler dev)
```

## Secrets

Set via `wrangler secret put <NAME>`, never in `wrangler.toml`'s `[vars]` (plaintext) or
committed to git: `ECHO_API_KEY`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`,
`REDDIT_USERNAME`, `REDDIT_PASSWORD`. Local dev secrets go in `.dev.vars` (gitignored).

## Security-sensitive changes

Anything touching the auth middleware or `timingSafeEqual` needs a test that would fail without
the fix — see `SECURITY.md` and `tests/security.test.ts`'s tamper-test discipline (verify a
regression is actually caught before trusting the guard).

## Adding a route

New routes are auto-protected by the global `X-Echo-API-Key` middleware unless explicitly
excluded (currently only `/`). Don't add new unauthenticated routes without discussing why.
