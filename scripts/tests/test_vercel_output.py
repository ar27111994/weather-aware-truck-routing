"""Tests for ``scripts/vercel_output.py``: the build-time CSP hashing and the output verification."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import vercel_output as vo  # noqa: E402

BASE_CSP = "default-src 'self'; script-src 'self'; object-src 'none'"
# sha256 of the bytes b"alert(1)" in the CSP source-expression form.
ALERT_HASH = "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='"


def _write_output(
    tmp_path: Path, html: str, csp: str = BASE_CSP, bundle: list[str] | None = None
) -> Path:
    out = tmp_path / "output"
    for name in vo.REQUIRED_STATIC:
        page = out / "static" / name
        page.parent.mkdir(parents=True, exist_ok=True)
        page.write_text(html, encoding="utf-8")
    routes = [{"src": "^/(.*)$", "headers": {"Content-Security-Policy": csp}, "continue": True}]
    config = {"version": 3, "routes": routes, "crons": [{"path": "/x", "schedule": "1 1 * * *"}]}
    (out / "config.json").write_text(json.dumps(config), encoding="utf-8")
    func = out / vo.FUNCTION_DIR
    func.mkdir(parents=True)
    files = bundle if bundle is not None else [*vo.REQUIRED_IN_BUNDLE, "_vendor/pkg/tests/t.py"]
    (func / ".vc-config.json").write_text(
        json.dumps({"filePathMap": {name: name for name in files}}), encoding="utf-8"
    )
    return out


def test_csp_hash_matches_the_browser_algorithm() -> None:
    assert vo.csp_hash("alert(1)") == ALERT_HASH


def test_only_executable_inline_scripts_are_hashed() -> None:
    html = (
        "<script>alert(1)</script>"
        '<script src="/a.js"></script>'
        '<script type="application/ld+json">{"@type": "WebApplication"}</script>'
        '<script type="module" async>alert(1)</script>'
    )

    assert vo.inline_script_hashes(html) == {ALERT_HASH}


def test_with_script_hashes_is_idempotent_and_sorted() -> None:
    once = vo.with_script_hashes(BASE_CSP, ["'sha256-b='", "'sha256-a='"])
    twice = vo.with_script_hashes(once, ["'sha256-a='", "'sha256-b='"])

    assert once == twice
    assert "script-src 'self' 'sha256-a=' 'sha256-b='" in once
    assert once.startswith("default-src 'self';")


def test_with_script_hashes_rejects_a_csp_without_script_src() -> None:
    with pytest.raises(SystemExit):
        vo.with_script_hashes("default-src 'self'", [ALERT_HASH])


def test_inject_then_verify_accepts_a_consistent_output(tmp_path: Path) -> None:
    out = _write_output(tmp_path, "<script>alert(1)</script>")

    assert vo.inject_csp(out) == 1
    assert vo.verify(out) == []
    assert ALERT_HASH in json.loads((out / "config.json").read_text())["routes"][0]["headers"][
        "Content-Security-Policy"
    ]


def test_verify_flags_an_inline_script_without_a_hash(tmp_path: Path) -> None:
    out = _write_output(tmp_path, "<script>alert(1)</script>")

    assert [p for p in vo.verify(out) if "is not allowed" in p]


def test_verify_flags_unsafe_script_sources(tmp_path: Path) -> None:
    out = _write_output(tmp_path, "<p>x</p>", csp="script-src 'self' 'unsafe-inline' 'unsafe-eval'")

    problems = vo.verify(out)

    assert any("'unsafe-inline'" in p for p in problems)
    assert any("'unsafe-eval'" in p for p in problems)


def test_verify_flags_a_bundle_that_ships_frontend_sources(tmp_path: Path) -> None:
    out = _write_output(tmp_path, "<p>x</p>", bundle=[*vo.REQUIRED_IN_BUNDLE, "frontend/app/x.ts"])

    assert vo.verify(out) == ["the function bundle ships frontend/app/x.ts"]


def test_verify_flags_missing_required_files(tmp_path: Path) -> None:
    out = _write_output(tmp_path, "<p>x</p>", bundle=["api/index.py"])
    (out / "static" / "methodology" / "index.html").unlink()

    problems = vo.verify(out)

    assert "static output is missing methodology/index.html" in problems
    assert "the function bundle lacks backend/src/haulcast/config/wsgi.py" in problems


def test_inject_fails_without_a_csp_header(tmp_path: Path) -> None:
    out = _write_output(tmp_path, "<p>x</p>")
    (out / "config.json").write_text(json.dumps({"routes": []}), encoding="utf-8")

    with pytest.raises(SystemExit):
        vo.inject_csp(out)


def test_main_reports_problems_through_the_exit_code(tmp_path: Path) -> None:
    out = _write_output(tmp_path, "<script>alert(1)</script>")

    assert vo.main(["verify", str(out)]) == 1
    assert vo.main(["inject-csp", str(out)]) == 0
    assert vo.main(["verify", str(out)]) == 0
