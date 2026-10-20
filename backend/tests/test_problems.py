"""The API's error vocabulary: every code has HTTP semantics and documents render predictably."""

import json
import re

import pytest

from haulcast.problems import (
    DEFAULT_ERROR_CODE,
    FALLBACK_BY_STATUS,
    PROBLEM_DOCS_URL,
    PROBLEMS,
    FieldError,
    ProblemError,
    document_for,
)

# The error model of API-CONTRACT.md: the codes clients branch on, with their statuses.
CONTRACT_CODES = {
    "malformed_json": 400,
    "invalid_content_type": 400,
    "plan_not_found": 404,
    "payload_too_large": 413,
    "validation_error": 422,
    "no_route_found": 422,
    "same_origin_destination": 422,
    "route_too_long": 422,
    "too_many_checkpoints": 422,
    "departure_out_of_range": 422,
    "rate_limited": 429,
    "routing_unavailable": 503,
    "weather_unavailable": 503,
    "weather_capacity_exhausted": 503,
}


def test_the_catalogue_contains_every_code_of_the_contract_with_its_status() -> None:
    assert {code: PROBLEMS[code].status for code in CONTRACT_CODES} == CONTRACT_CODES


@pytest.mark.parametrize("code", sorted(PROBLEMS))
def test_every_code_has_a_snake_case_name_a_kebab_case_anchor_and_a_sane_status(code: str) -> None:
    spec = PROBLEMS[code]

    assert re.fullmatch(r"[a-z]+(_[a-z]+)*", code)
    assert re.fullmatch(r"[a-z]+(-[a-z]+)*", spec.anchor)
    assert 400 <= spec.status <= 599
    assert spec.title
    assert not spec.title.endswith(".")


def test_anchors_and_titles_identify_exactly_one_code() -> None:
    anchors = [spec.anchor for spec in PROBLEMS.values()]
    titles = [spec.title for spec in PROBLEMS.values()]

    assert len(set(anchors)) == len(anchors)
    assert len(set(titles)) == len(titles)


def test_fallback_codes_exist_and_keep_the_status_they_stand_for() -> None:
    for status, code in FALLBACK_BY_STATUS.items():
        assert PROBLEMS[code].status == status


def test_the_default_error_code_is_a_known_server_error() -> None:
    assert PROBLEMS[DEFAULT_ERROR_CODE].status == 500


def test_a_problem_error_carries_its_code_spec_and_a_readable_message() -> None:
    error = ProblemError("rate_limited", detail="slow down", retry_after_s=3.5)

    assert (error.code, error.status, error.detail, error.retry_after_s) == (
        "rate_limited",
        429,
        "slow down",
        3.5,
    )
    assert error.spec is PROBLEMS["rate_limited"]
    assert str(error) == "rate_limited: slow down"
    assert str(ProblemError("not_found")) == "not_found"


def test_a_problem_error_status_can_override_the_catalogue() -> None:
    assert ProblemError("weather_unavailable", status=502).status == 502


def test_a_problem_error_keeps_field_errors_as_a_tuple() -> None:
    fields = [FieldError(("body", "lat"), "too big", "less_than_equal")]

    assert ProblemError("validation_error", errors=fields).errors == tuple(fields)


def test_the_document_links_to_the_documented_anchor() -> None:
    document = document_for(ProblemError("plan_not_found"), "req-1")

    assert document.type == f"{PROBLEM_DOCS_URL}#plan-not-found"
    assert (document.title, document.status, document.code) == (
        "Plan not found",
        404,
        "plan_not_found",
    )


def test_the_json_body_omits_detail_and_errors_when_there_are_none() -> None:
    body = document_for(ProblemError("not_found"), "req-1").to_json_object()

    assert list(body) == ["type", "title", "status", "code", "request_id"]


def test_the_json_body_lists_detail_and_errors_in_a_stable_order() -> None:
    error = ProblemError(
        "validation_error",
        detail="lat: too big",
        errors=[FieldError(("body", "origin", "lat"), "too big", "less_than_equal")],
    )

    body = document_for(error, "req-2").to_json_object()

    assert list(body) == ["type", "title", "status", "detail", "code", "errors", "request_id"]
    assert body["errors"] == [
        {"loc": ["body", "origin", "lat"], "msg": "too big", "type": "less_than_equal"}
    ]
    assert json.loads(json.dumps(body)) == body
