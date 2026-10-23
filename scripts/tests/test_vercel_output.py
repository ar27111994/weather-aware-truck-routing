"""Tests for ``scripts/vercel_output.py``: the build-time CSP hashing and the output verification."""

import json
import runpy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import vercel_output as vo  # noqa: E402

# The committed shape (vercel.json): hashes are added to script-src and style-src at build time.
BASE_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; "
    "object-src 'none'"
)
# sha256 of the bytes b"alert(1)" in the CSP source-expression form.
ALERT_HASH = "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='"
RED_CSS = "p{color:red}"
RED_HASH = vo.csp_hash(RED_CSS)


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

    assert vo.inject_csp(out) == vo.Injected(scripts=1, styles=1)
    assert vo.verify(out) == []
    assert (
        ALERT_HASH
        in json.loads((out / "config.json").read_text())["routes"][0]["headers"][
            "Content-Security-Policy"
        ]
    )


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


def test_a_csp_with_empty_directives_is_parsed() -> None:
    csp = "default-src 'self';; script-src 'self'; "

    assert (
        vo.with_script_hashes(csp, [ALERT_HASH])
        == f"default-src 'self'; script-src 'self' {ALERT_HASH}"
    )


def test_routes_without_headers_are_skipped_when_looking_for_the_csp(tmp_path: Path) -> None:
    out = _write_output(tmp_path, "<p>x</p>")
    config = json.loads((out / "config.json").read_text(encoding="utf-8"))
    config["routes"] = [{"handle": "filesystem"}, {"src": "^/x$", "dest": "/y"}, *config["routes"]]
    (out / "config.json").write_text(json.dumps(config), encoding="utf-8")

    assert vo.inject_csp(out) == vo.Injected(scripts=0, styles=1)
    assert vo.verify(out) == []


def test_verify_flags_a_missing_csp_header_a_missing_cron_and_a_missing_function(
    tmp_path: Path,
) -> None:
    out = _write_output(tmp_path, "<p>x</p>")
    (out / "config.json").write_text(json.dumps({"routes": []}), encoding="utf-8")
    (out / vo.FUNCTION_DIR / ".vc-config.json").unlink()

    problems = vo.verify(out)

    assert "config.json carries no Content-Security-Policy header" in problems
    assert "config.json registers no cron job" in problems
    assert "the Python function bundle is missing (functions/api/index.func)" in problems


def test_the_script_can_be_run_directly(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    out = _write_output(tmp_path, "<p>x</p>")
    monkeypatch.setattr(sys, "argv", ["vercel_output.py", "verify", str(out)])

    with pytest.raises(SystemExit) as stopped:
        runpy.run_path(str(Path(vo.__file__)), run_name="__main__")

    assert stopped.value.code == 0


# ---- D-25 (R1-25): inline <style> elements are hashed, style attributes are not ----------------


def _csp_of(out: Path) -> str:
    config = json.loads((out / "config.json").read_text(encoding="utf-8"))
    return str(config["routes"][0]["headers"]["Content-Security-Policy"])


def test_only_css_inline_styles_are_hashed() -> None:
    html = (
        f"<style>{RED_CSS}</style>"
        f'<style type="text/css" media="print">{RED_CSS}</style>'
        '<style type="text/plain">not css, never applied</style>'
        '<link rel="stylesheet" href="/a.css">'
        "<style></style>"
    )

    assert vo.inline_style_hashes(html) == {RED_HASH, vo.csp_hash("")}


def test_styles_deep_in_the_page_are_found_and_scripts_are_not_styles() -> None:
    html = "<body><main><svg><style>.a{fill:red}</style></svg></main><script>alert(1)</script></body>"

    assert vo.inline_style_hashes(html) == {vo.csp_hash(".a{fill:red}")}
    assert vo.inline_script_hashes(html) == {ALERT_HASH}


def test_style_attributes_are_not_inline_styles() -> None:
    assert vo.inline_style_hashes('<p style="color: red">x</p>') == set()


def test_with_style_hashes_is_idempotent_sorted_and_leaves_the_attribute_policy_alone() -> None:
    once = vo.with_style_hashes(BASE_CSP, ["'sha256-b='", "'sha256-a='"])
    twice = vo.with_style_hashes(once, ["'sha256-a='", "'sha256-b='"])

    assert once == twice
    assert "style-src 'self' 'sha256-a=' 'sha256-b=';" in once
    assert "style-src-attr 'unsafe-inline'" in once
    assert "script-src 'self';" in once


def test_with_style_hashes_also_extends_style_src_elem_when_the_policy_has_one() -> None:
    csp = f"{BASE_CSP}; style-src-elem 'self'"

    assert vo.with_style_hashes(csp, ["'sha256-a='"]).endswith("style-src-elem 'self' 'sha256-a='")


def test_with_style_hashes_rejects_a_csp_without_style_src() -> None:
    with pytest.raises(SystemExit):
        vo.with_style_hashes("default-src 'self'; script-src 'self'", [RED_HASH])


def test_inject_then_verify_accepts_a_page_with_an_inline_style(tmp_path: Path) -> None:
    out = _write_output(tmp_path, f"<style>{RED_CSS}</style><script>alert(1)</script>")

    assert vo.inject_csp(out) == vo.Injected(scripts=1, styles=2)
    assert vo.verify(out) == []
    csp = _csp_of(out)
    style_src = csp.split("style-src ")[1].split(";")[0]
    assert style_src.split() == ["'self'", *sorted([RED_HASH, PREVENT_SCROLL_HASH])]
    assert f"script-src 'self' {ALERT_HASH}" in csp
    assert RED_HASH not in csp.split("script-src")[1].split(";")[0]


def test_verify_flags_an_inline_style_without_a_hash(tmp_path: Path) -> None:
    out = _write_output(tmp_path, f"<style>{RED_CSS}</style>")

    assert vo.verify(out) == [f"inline style {RED_HASH} is not allowed by style-src"]


def _csp_with(directive: str, sources: str) -> str:
    """``BASE_CSP`` with one directive replaced (or added at the end)."""
    parts = [part.strip() for part in BASE_CSP.split(";") if part.strip()]
    kept = [part for part in parts if part.split()[0] != directive]
    return "; ".join([*kept, f"{directive} {sources}"])


def test_verify_checks_the_directive_the_browser_uses_for_style_elements(tmp_path: Path) -> None:
    csp = _csp_with("style-src", f"'self' {RED_HASH}") + "; style-src-elem 'self'"
    out = _write_output(tmp_path, f"<style>{RED_CSS}</style>", csp=csp)

    # style-src carries the hash, but style-src-elem overrides it for <style> elements.
    assert vo.verify(out) == [f"inline style {RED_HASH} is not allowed by style-src-elem"]


@pytest.mark.parametrize("directive", ["style-src", "style-src-elem"])
def test_verify_flags_unsafe_inline_in_the_style_directives(
    tmp_path: Path, directive: str
) -> None:
    out = _write_output(tmp_path, "<p>x</p>", csp=_csp_with(directive, "'self' 'unsafe-inline'"))

    assert vo.verify(out) == [
        f"{directive} must not allow 'unsafe-inline' (an inline <style> is allowed by its hash)"
    ]


def test_verify_accepts_unsafe_inline_for_style_attributes_only(tmp_path: Path) -> None:
    out = _write_output(tmp_path, "<p>x</p>", csp=BASE_CSP)

    assert "'unsafe-inline'" in _csp_of(out)
    assert vo.verify(out) == []


def test_main_reports_how_many_hashes_it_allowed(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = _write_output(tmp_path, f"<style>{RED_CSS}</style><script>alert(1)</script>")

    assert vo.main(["inject-csp", str(out)]) == 0

    assert capsys.readouterr().out.strip() == (
        "inject-csp: allowed 1 inline script hash(es) in script-src "
        "and 2 inline style hash(es) in style-src"
    )


# R3-01: React Aria prepends this <style> to <head> when a modal overlay opens on iOS. It is in no
# page, so only a listed hash allows it. The value is the SHA-256 that R3 computed on its own from
# the text in react-aria (.planning/evidence/r3-ds-followups/csp/style_hashes.py).
PREVENT_SCROLL_HASH = "'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='"


def test_the_runtime_styles_are_hashed_from_their_texts() -> None:
    assert vo.runtime_style_hashes() == {PREVENT_SCROLL_HASH}


def test_the_runtime_styles_come_from_the_file_given(tmp_path: Path) -> None:
    listing = tmp_path / "styles.json"
    listing.write_text(json.dumps({"styles": [{"text": "a{}"}, {"text": "b{}"}]}), encoding="utf-8")

    assert vo.runtime_style_hashes(listing) == {vo.csp_hash("a{}"), vo.csp_hash("b{}")}


def test_inject_allows_the_runtime_styles_in_style_src_and_verify_accepts_it(
    tmp_path: Path,
) -> None:
    out = _write_output(tmp_path, "<p>no inline style here</p>")

    vo.inject_csp(out)

    assert PREVENT_SCROLL_HASH in _csp_of(out)
    assert vo.verify(out) == []
