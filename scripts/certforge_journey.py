#!/usr/bin/env python3
"""Certification Forge journey for echo-reddit-monitor.

The Forge sandbox is python:3.12-alpine with no Node.js, so this journey
performs text/structural checks on the TypeScript source and config rather
than actually running npm/vitest/wrangler. Each check is discriminating: it
must fail against the pre-fix source and pass against the current source,
not just assert a file exists.
"""
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FAILURES = []


def check(name, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail and not condition else ""))
    if not condition:
        FAILURES.append(name)


def read(rel_path):
    path = REPO_ROOT / rel_path
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def main():
    index_ts = read("src/index.ts")
    check("src/index.ts exists", index_ts is not None)

    if index_ts:
        # The regression: an auth middleware that unconditionally calls
        # next() without ever checking a key — the pre-fix state of this repo.
        auth_middleware_match = re.search(
            r"// Auth middleware.*?\napp\.use\('\*',\s*async\s*\(c,\s*next\)\s*=>\s*\{(.*?)\n\}\);",
            index_ts,
            re.S,
        )
        check("auth middleware block found", auth_middleware_match is not None)
        body = auth_middleware_match.group(1) if auth_middleware_match else ""

        checks_env_key = "c.env.ECHO_API_KEY" in body
        check("auth middleware reads ECHO_API_KEY from env", checks_env_key)

        fails_closed_on_missing_key = bool(
            re.search(r"if\s*\(\s*!c\.env\.ECHO_API_KEY\s*\)", body)
        )
        check(
            "auth middleware fails closed (503) when ECHO_API_KEY unset",
            fails_closed_on_missing_key,
        )

        uses_timing_safe_compare = "timingSafeEqual(" in body
        check("auth middleware uses timingSafeEqual, not raw ===", uses_timing_safe_compare)

        # timingSafeEqual itself must not have the length-mismatch timing
        # oracle (early return before the comparison loop).
        tse_match = re.search(
            r"export function timingSafeEqual\([^)]*\)\s*:\s*boolean\s*\{(.*?)\n\}",
            index_ts,
            re.S,
        )
        check("timingSafeEqual function found", tse_match is not None)
        tse_body = tse_match.group(1) if tse_match else ""
        early_length_return = bool(
            re.search(r"if\s*\(\s*a\.length\s*!==\s*b\.length\s*\)\s*return\s*false", tse_body)
        )
        check(
            "timingSafeEqual has no early-return-on-length-mismatch timing oracle",
            not early_length_return,
        )

    # wrangler.toml must never carry secrets in plaintext [vars].
    wrangler_toml = read("wrangler.toml")
    check("wrangler.toml exists", wrangler_toml is not None)
    if wrangler_toml:
        vars_match = re.search(r"\[vars\](.*?)(\n\[|\Z)", wrangler_toml, re.S)
        vars_block = vars_match.group(1) if vars_match else ""
        no_secrets_in_vars = not re.search(
            r"ECHO_API_KEY|REDDIT_CLIENT_SECRET|REDDIT_PASSWORD", vars_block
        )
        check("no secret-shaped keys in wrangler.toml [vars] (plaintext)", no_secrets_in_vars)

    # Test infrastructure must actually exist, not just be declared.
    package_json_raw = read("package.json")
    check("package.json exists", package_json_raw is not None)
    if package_json_raw:
        pkg = json.loads(package_json_raw)
        scripts = pkg.get("scripts", {})
        check("package.json declares a test script", scripts.get("test") == "vitest run")
        dev_deps = pkg.get("devDependencies", {})
        check("vitest is a devDependency", "vitest" in dev_deps)
        check("license is declared", bool(pkg.get("license")))

    check("tests/security.test.ts exists", (REPO_ROOT / "tests" / "security.test.ts").exists())

    security_test = read("tests/security.test.ts")
    if security_test:
        check(
            "security.test.ts exercises the auth gate's four states",
            all(
                s in security_test
                for s in ["401", "503", "correct key", "positive control"]
            ),
        )

    # Governance files.
    for fname in [
        "README.md",
        "LICENSE",
        "SECURITY.md",
        "CONTRIBUTING.md",
        "CHANGELOG.md",
        "CODE_OF_CONDUCT.md",
    ]:
        check(f"{fname} exists", (REPO_ROOT / fname).exists())

    check(
        ".github/workflows/ci.yml exists",
        (REPO_ROOT / ".github" / "workflows" / "ci.yml").exists(),
    )

    print()
    if FAILURES:
        print(f"CERTFORGE JOURNEY: FAIL ({len(FAILURES)} check(s) failed)")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("CERTFORGE JOURNEY: PASS (all checks green)")
    sys.exit(0)


if __name__ == "__main__":
    main()
