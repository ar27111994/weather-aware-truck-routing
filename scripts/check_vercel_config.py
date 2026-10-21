"""Validate ``vercel.json`` against the official schema and against this project's invariants.

Run in CI (``uv run --no-project --with jsonschema python scripts/check_vercel_config.py``). The
schema is fetched from https://openapi.vercel.sh/vercel.json unless ``VERCEL_SCHEMA_FILE`` points at
a local copy (offline use). Exit status 1 lists every violation.
"""

import json
import os
import re
import sys
import urllib.request
from pathlib import Path
from typing import Any

from jsonschema import validators

SCHEMA_URL = "https://openapi.vercel.sh/vercel.json"
CONFIG_PATH = Path(__file__).resolve().parents[1] / "vercel.json"
REQUIRED_HEADERS = (
    "strict-transport-security",
    "x-content-type-options",
    "referrer-policy",
    "permissions-policy",
    "cross-origin-opener-policy",
    "cross-origin-resource-policy",
    "content-security-policy",
)
# Hobby plan: a cron may run at most once a day, so only "m h * * *" style schedules are valid.
DAILY_CRON = re.compile(r"^\d{1,2} \d{1,2} \* \* \*$")
SPA_FALLBACK_DESTINATION = "/__spa-fallback.html"
# D-27: /design is public (the living style guide) and kept out of search results by a header, which
# works for crawlers that never run the page's JavaScript. Nothing else may be noindex.
ROBOTS_SOURCE = "/design/:path*"


def load_schema() -> dict[str, Any]:
    local = os.environ.get("VERCEL_SCHEMA_FILE")
    if local:
        return json.loads(Path(local).read_text(encoding="utf-8"))
    with urllib.request.urlopen(SCHEMA_URL, timeout=30) as response:  # noqa: S310 - fixed https URL
        return json.loads(response.read())


def schema_errors(config: dict[str, Any], schema: dict[str, Any]) -> list[str]:
    validator = validators.validator_for(schema)(schema)
    return [
        f"schema: {'/'.join(str(p) for p in e.absolute_path) or '<root>'}: {e.message}"
        for e in sorted(validator.iter_errors(config), key=lambda e: list(map(str, e.path)))
    ]


def _headers(config: dict[str, Any]) -> dict[str, dict[str, str]]:
    """``source -> {lower-cased header name: value}``."""
    return {
        rule["source"]: {h["key"].lower(): h["value"] for h in rule["headers"]}
        for rule in config.get("headers", [])
    }


def _directives(csp: str) -> dict[str, list[str]]:
    parsed: dict[str, list[str]] = {}
    for part in csp.split(";"):
        tokens = part.split()
        if tokens:
            parsed[tokens[0]] = tokens[1:]
    return parsed


def _spa_fallback_errors(config: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    rewrites = config.get("rewrites", [])
    if [r["destination"] for r in rewrites][:1] != ["/api/index"]:
        errors.append("rewrites: the /api/(.*) rewrite must come first")
    fallbacks = [r for r in rewrites if r["destination"] == SPA_FALLBACK_DESTINATION]
    if len(fallbacks) != 1:
        return [*errors, f"rewrites: exactly one {SPA_FALLBACK_DESTINATION} fallback is required"]
    pattern = re.compile("^" + fallbacks[0]["source"] + "$")
    expectations = {
        "/trip/abc": True,  # an unknown client route falls back to the SPA shell
        "/assets/app-abc123.js": False,  # a missing hashed asset must 404, not return HTML
        "/api/v1/health": False,
        "/favicon.ico": False,
        "/robots.txt": False,
    }
    errors += [
        f"rewrites: SPA fallback {'must' if want else 'must not'} match {path}"
        for path, want in expectations.items()
        if bool(pattern.match(path)) != want
    ]
    return errors


def invariant_errors(config: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if config.get("framework", "<absent>") is not None:
        errors.append('framework must be null (no Django preset: static SPA + one function)')
    if config.get("git", {}).get("deploymentEnabled") is not False:
        errors.append("git.deploymentEnabled must be false (deploys run from GitHub Actions)")
    if config.get("regions") != ["iad1"]:
        errors.append('regions must be ["iad1"] (co-located with Supabase us-east-1)')
    if config.get("outputDirectory") != "frontend/build/client":
        errors.append("outputDirectory must be the prerendered React Router client build")
    function = config.get("functions", {}).get("api/index.py", {})
    if not 1 <= function.get("maxDuration", 0) <= 60:
        errors.append("functions.api/index.py.maxDuration must be between 1 and 60 seconds")
    excludes = function.get("excludeFiles", "")
    errors += [
        f"functions.api/index.py.excludeFiles must exclude {needed}"
        for needed in ("frontend/**", "node_modules/**", "**/tests/**")
        if needed not in excludes
    ]
    errors += _spa_fallback_errors(config)
    errors += _header_errors(config)
    crons = config.get("crons", [])
    if [c.get("path") for c in crons] != ["/api/v1/internal/maintenance"]:
        errors.append("crons must contain exactly the maintenance endpoint")
    errors += [
        f"crons: {c['schedule']!r} is not a daily schedule" for c in crons
        if not DAILY_CRON.match(c["schedule"])
    ]
    return errors


def _robots_errors(by_source: dict[str, dict[str, str]]) -> list[str]:
    carriers = {src: h["x-robots-tag"] for src, h in by_source.items() if "x-robots-tag" in h}
    design = carriers.pop(ROBOTS_SOURCE, None)
    errors: list[str] = []
    if design is None:
        errors.append(f"headers: X-Robots-Tag is missing for {ROBOTS_SOURCE} (the kitchen sink is noindex)")
    elif "noindex" not in design.lower():
        errors.append(f"headers: X-Robots-Tag for {ROBOTS_SOURCE} must say noindex, got {design!r}")
    errors += [
        f"headers: X-Robots-Tag is set for {source}, but only {ROBOTS_SOURCE} may carry it"
        for source in carriers
    ]
    return errors


def _header_errors(config: dict[str, Any]) -> list[str]:
    by_source = _headers(config)
    merged = {key: value for headers in by_source.values() for key, value in headers.items()}
    errors = [f"headers: {name} is missing" for name in REQUIRED_HEADERS if name not in merged]
    hsts = merged.get("strict-transport-security", "")
    max_age = re.search(r"max-age=(\d+)", hsts)
    if not (max_age and int(max_age[1]) >= 31_536_000 and "includeSubDomains" in hsts
            and "preload" in hsts):
        errors.append("headers: HSTS must be preload-ready (max-age>=1y, includeSubDomains, preload)")
    csp = _directives(merged.get("content-security-policy", ""))
    if "unsafe-eval" in merged.get("content-security-policy", ""):
        errors.append("headers: the CSP must not contain 'unsafe-eval'")
    if csp.get("script-src") != ["'self'"]:
        errors.append("headers: committed script-src must be exactly 'self' (hashes are added at build)")
    # D-25: an inline <style> element is allowed by its hash, added at build like the script hashes.
    # Style attributes are allowed outright: React and React Aria write them, and an attribute cannot
    # carry a selector that leaks data.
    if csp.get("style-src") != ["'self'"]:
        errors.append("headers: committed style-src must be exactly 'self' (hashes are added at build)")
    if csp.get("style-src-attr") != ["'unsafe-inline'"]:
        errors.append(
            "headers: style-src-attr must be exactly 'unsafe-inline' (React Aria writes style attributes)"
        )
    if "'unsafe-inline'" in csp.get("style-src-elem", []):
        errors.append("headers: style-src-elem must not allow 'unsafe-inline'")
    # D-25: MapLibre 6 runs its web worker from a same-origin asset (frontend/app/features/map,
    # `setWorkerUrl`), so a worker never needs a blob: URL; allowing one would widen the policy.
    if csp.get("worker-src") != ["'self'"]:
        errors.append("headers: worker-src must be exactly 'self' (the map worker is same-origin)")
    errors += [
        f"headers: CSP lacks {directive} {value}"
        for directive, value in (
            ("object-src", "'none'"), ("base-uri", "'self'"), ("frame-ancestors", "'none'"),
            ("connect-src", "https://tiles.openfreemap.org"),
        )
        if value not in csp.get(directive, [])
    ]
    errors += _robots_errors(by_source)
    cache = {src: h.get("cache-control", "") for src, h in by_source.items()}
    if not any("immutable" in v and "31536000" in v for v in cache.values()):
        errors.append("headers: hashed assets need a long immutable Cache-Control")
    return errors


def main() -> int:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    errors = schema_errors(config, load_schema()) + invariant_errors(config)
    for error in errors:
        print(f"vercel.json: {error}", file=sys.stderr)
    if not errors:
        print("vercel.json: valid against the official schema and all project invariants hold")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
