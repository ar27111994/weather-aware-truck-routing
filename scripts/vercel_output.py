"""Post-build processing and verification of a ``vercel build`` output directory (``.vercel/output``).

Why this exists: React Router's prerendered pages carry inline ``<script>`` elements (hydration
context, route-module imports with content-hashed asset names, React's streaming runtime). A strict
CSP (``script-src 'self'``, no ``'unsafe-inline'``) blocks every one of them, so the page would never
hydrate. Their hashes change with each build, so they cannot live in the committed ``vercel.json``.
``inject-csp`` therefore computes the SHA-256 of every executable inline script in the built HTML
and appends the hashes to the ``script-src`` directive of the ``Content-Security-Policy`` header
that ``vercel build`` wrote into ``config.json``. ``verify`` proves the result: every inline script
is allowed, nothing unsafe is allowed, the function bundle is lean and the static tree is complete.

Usage: ``python scripts/vercel_output.py inject-csp|verify [OUTPUT_DIR]`` (default ``.vercel/output``).
Standard library only, so it runs anywhere a Python 3 interpreter exists.
"""

import argparse
import base64
import hashlib
import json
import sys
from collections.abc import Iterable
from html.parser import HTMLParser
from pathlib import Path

CSP_HEADER = "content-security-policy"
DEFAULT_OUTPUT = Path(".vercel/output")
FUNCTION_DIR = Path("functions/api/index.func")
REQUIRED_STATIC = ("index.html", "methodology/index.html", "__spa-fallback.html")
REQUIRED_IN_BUNDLE = ("api/index.py", "backend/src/haulcast/config/wsgi.py")
FORBIDDEN_BUNDLE_PREFIXES = ("frontend/", "node_modules/", ".git/", ".github/", ".planning/")
# Script `type` values the browser executes (and CSP therefore governs). Anything else, such as
# `application/ld+json`, is an inert data block.
_EXECUTABLE_TYPES = frozenset(
    {"", "module", "importmap", "speculationrules", "text/javascript", "application/javascript"}
)


class InlineScriptParser(HTMLParser):
    """Collects the text of every inline ``<script>`` as ``(type, text)``."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.scripts: list[tuple[str, str]] = []
        self._type: str | None = None
        self._chunks: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "script":
            return
        attributes = dict(attrs)
        self._type = None if "src" in attributes else (attributes.get("type") or "").strip().lower()
        self._chunks = []

    def handle_data(self, data: str) -> None:
        if self._type is not None:
            self._chunks.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._type is not None:
            self.scripts.append((self._type, "".join(self._chunks)))
            self._type = None


def csp_hash(script_text: str) -> str:
    """The CSP source expression (``'sha256-...'``) a browser computes for an inline script."""
    digest = hashlib.sha256(script_text.encode("utf-8")).digest()
    return f"'sha256-{base64.b64encode(digest).decode('ascii')}'"


def inline_script_hashes(html: str) -> set[str]:
    """Hashes of the executable inline scripts in one HTML document."""
    parser = InlineScriptParser()
    parser.feed(html)
    parser.close()
    return {csp_hash(text) for kind, text in parser.scripts if kind in _EXECUTABLE_TYPES}


def static_hashes(static_dir: Path) -> set[str]:
    """Union of the inline-script hashes over every HTML file in the static output."""
    hashes: set[str] = set()
    for page in sorted(static_dir.rglob("*.html")):
        hashes |= inline_script_hashes(page.read_text(encoding="utf-8"))
    return hashes


def _directives(csp: str) -> dict[str, list[str]]:
    parsed: dict[str, list[str]] = {}
    for part in csp.split(";"):
        tokens = part.split()
        if tokens:
            parsed[tokens[0]] = tokens[1:]
    return parsed


def with_script_hashes(csp: str, hashes: Iterable[str]) -> str:
    """Return ``csp`` with ``script-src`` extended by ``hashes`` (idempotent, deterministic)."""
    directives = _directives(csp)
    if "script-src" not in directives:
        raise SystemExit("the committed CSP has no script-src directive")
    kept = [t for t in directives["script-src"] if not t.startswith("'sha256-")]
    directives["script-src"] = [*kept, *sorted(set(hashes))]
    return "; ".join(" ".join([name, *tokens]) for name, tokens in directives.items())


def _csp_headers(config: dict[str, object]) -> list[tuple[dict[str, str], str]]:
    """Every (headers-dict, key) in ``config.json`` routes that carries the CSP header."""
    found: list[tuple[dict[str, str], str]] = []
    routes = config.get("routes", [])
    assert isinstance(routes, list)
    for route in routes:
        headers = route.get("headers") if isinstance(route, dict) else None
        if isinstance(headers, dict):
            found.extend((headers, key) for key in headers if key.lower() == CSP_HEADER)
    return found


def inject_csp(output: Path) -> int:
    """Append the built pages' inline-script hashes to the CSP in ``config.json``."""
    hashes = static_hashes(output / "static")
    config_path = output / "config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    targets = _csp_headers(config)
    if not targets:
        raise SystemExit("config.json carries no Content-Security-Policy header: check vercel.json")
    for headers, key in targets:
        headers[key] = with_script_hashes(headers[key], hashes)
    config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return len(hashes)


def verify(output: Path) -> list[str]:
    """Problems found in the build output (an empty list means it is deployable)."""
    problems: list[str] = []
    config = json.loads((output / "config.json").read_text(encoding="utf-8"))
    targets = _csp_headers(config)
    if not targets:
        problems.append("config.json carries no Content-Security-Policy header")
    allowed_hashes: set[str] = set()
    for headers, key in targets:
        script_src = _directives(headers[key]).get("script-src", [])
        allowed_hashes |= {token for token in script_src if token.startswith("'sha256-")}
        problems += [
            f"script-src must not allow {token}"
            for token in ("'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'")
            if token in script_src
        ]
        if "'unsafe-eval'" in headers[key]:
            problems.append("the CSP must not contain 'unsafe-eval' in any directive")
    problems += [
        f"inline script {hash_} is not allowed by script-src"
        for hash_ in sorted(static_hashes(output / "static") - allowed_hashes)
    ]
    problems += [
        f"static output is missing {name}"
        for name in REQUIRED_STATIC
        if not (output / "static" / name).is_file()
    ]
    if not config.get("crons"):
        problems.append("config.json registers no cron job")
    problems += _bundle_problems(output)
    return problems


def _bundle_problems(output: Path) -> list[str]:
    vc_config = output / FUNCTION_DIR / ".vc-config.json"
    if not vc_config.is_file():
        return ["the Python function bundle is missing (functions/api/index.func)"]
    paths = sorted(json.loads(vc_config.read_text(encoding="utf-8")).get("filePathMap", {}))
    problems = [
        f"the function bundle ships {path}"
        for path in paths
        if path.startswith(FORBIDDEN_BUNDLE_PREFIXES) or "/tests/" in path.removeprefix("_vendor/")
        if not path.startswith("_vendor/")
    ]
    problems += [f"the function bundle lacks {name}" for name in REQUIRED_IN_BUNDLE if name not in paths]
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("command", choices=("inject-csp", "verify"))
    parser.add_argument("output", nargs="?", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args(argv)
    if args.command == "inject-csp":
        count = inject_csp(args.output)
        print(f"inject-csp: allowed {count} distinct inline script hash(es) in script-src")
        return 0
    problems = verify(args.output)
    for problem in problems:
        print(f"verify: {problem}", file=sys.stderr)
    if not problems:
        print("verify: CSP covers every inline script, bundle is lean, static tree is complete")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
