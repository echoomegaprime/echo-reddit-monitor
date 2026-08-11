# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Fixed
- **Security (critical):** every route was completely unauthenticated. Added a fail-closed
  `X-Echo-API-Key` middleware (constant-time comparison) on all routes except `/`.
- `npm audit`: resolved all 8 findings to 0 — `hono` via `npm audit fix`; `wrangler` toolchain
  (undici/ws/miniflare/esbuild/sharp) via a v3→v4 major bump, verified with a dry-run deploy.

### Added
- First test suite: `vitest`, 14 tests covering `timingSafeEqual`, `matchesKeywords`, and all
  four auth states (missing/wrong/unconfigured key, positive control).
- `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `LICENSE`, `.github/` templates + CI.

## [1.2.0] and earlier

See git history — this file starts tracking from the current consolidation pass forward.
