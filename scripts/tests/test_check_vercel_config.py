"""Tests for ``scripts/check_vercel_config.py``: the invariants the committed ``vercel.json`` must keep."""

import copy
import json
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check_vercel_config as cvc  # noqa: E402

COMMITTED: dict[str, Any] = json.loads(cvc.CONFIG_PATH.read_text(encoding="utf-8"))


def _config(mutate: Any = None) -> dict[str, Any]:
    config = copy.deepcopy(COMMITTED)
    if mutate is not None:
        mutate(config)
    return config


def _csp_headers(config: dict[str, Any]) -> list[dict[str, str]]:
    return [
        header
        for rule in config["headers"]
        for header in rule["headers"]
        if header["key"].lower() == "content-security-policy"
    ]


def _set_directive(directive: str, sources: str | None) -> Any:
    """A mutation that replaces one directive of the CSP (or removes it when ``sources`` is None)."""

    def mutate(config: dict[str, Any]) -> None:
        for header in _csp_headers(config):
            kept = [
                part.strip()
                for part in header["value"].split(";")
                if part.strip() and part.split()[0] != directive
            ]
            if sources is not None:
                kept.append(f"{directive} {sources}")
            header["value"] = "; ".join(kept)

    return mutate


def test_the_committed_config_keeps_every_invariant() -> None:
    assert cvc.invariant_errors(COMMITTED) == []


def test_the_committed_csp_allows_style_attributes_but_not_inline_style_elements() -> None:
    (header,) = _csp_headers(COMMITTED)
    directives = cvc._directives(header["value"])

    assert directives["style-src"] == ["'self'"]
    assert directives["style-src-attr"] == ["'unsafe-inline'"]


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (
            _set_directive("style-src", "'self' 'unsafe-inline'"),
            "style-src must be exactly 'self'",
        ),
        (_set_directive("style-src", None), "style-src must be exactly 'self'"),
        (
            _set_directive("style-src", "'self' 'sha256-AAAA='"),
            "style-src must be exactly 'self'",
        ),
        (
            _set_directive("style-src-attr", None),
            "style-src-attr must be exactly 'unsafe-inline'",
        ),
        (
            _set_directive("style-src-attr", "'self'"),
            "style-src-attr must be exactly 'unsafe-inline'",
        ),
        (
            _set_directive("style-src-elem", "'self' 'unsafe-inline'"),
            "style-src-elem must not allow 'unsafe-inline'",
        ),
    ],
)
def test_it_rejects_a_csp_that_weakens_or_drops_the_style_policy(
    mutation: Any, message: str
) -> None:
    errors = cvc.invariant_errors(_config(mutation))

    assert [error for error in errors if message in error], errors


def test_it_accepts_a_style_src_elem_that_keeps_to_self() -> None:
    assert cvc.invariant_errors(_config(_set_directive("style-src-elem", "'self'"))) == []


def test_the_committed_csp_runs_workers_from_its_own_origin_only() -> None:
    (header,) = _csp_headers(COMMITTED)

    assert cvc._directives(header["value"])["worker-src"] == ["'self'"]


@pytest.mark.parametrize(
    "sources",
    ["'self' blob:", "blob:", None],
)
def test_it_rejects_a_worker_src_other_than_self(sources: str | None) -> None:
    errors = cvc.invariant_errors(_config(_set_directive("worker-src", sources)))

    assert [error for error in errors if "worker-src must be exactly 'self'" in error], errors


def _robots_rules(config: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        rule
        for rule in config["headers"]
        if any(header["key"].lower() == "x-robots-tag" for header in rule["headers"])
    ]


def test_the_kitchen_sink_is_kept_out_of_search_results_by_a_header() -> None:
    (rule,) = _robots_rules(COMMITTED)

    assert rule["source"] == "/design/:path*"
    assert rule["headers"] == [{"key": "X-Robots-Tag", "value": "noindex, nofollow"}]


def test_it_rejects_a_config_without_the_noindex_header_for_design() -> None:
    def drop(config: dict[str, Any]) -> None:
        config["headers"] = [rule for rule in config["headers"] if rule not in _robots_rules(config)]

    errors = cvc.invariant_errors(_config(drop))

    assert any("X-Robots-Tag" in error and "/design" in error for error in errors), errors


def test_it_rejects_a_design_header_that_does_not_say_noindex() -> None:
    def soften(config: dict[str, Any]) -> None:
        (rule,) = _robots_rules(config)
        rule["headers"] = [{"key": "X-Robots-Tag", "value": "all"}]

    errors = cvc.invariant_errors(_config(soften))

    assert any("noindex" in error for error in errors), errors


def test_it_rejects_noindex_anywhere_else_so_the_planner_stays_indexable() -> None:
    def spread(config: dict[str, Any]) -> None:
        config["headers"].append(
            {"source": "/methodology", "headers": [{"key": "X-Robots-Tag", "value": "noindex"}]}
        )

    errors = cvc.invariant_errors(_config(spread))

    assert any("only /design/:path*" in error for error in errors), errors
