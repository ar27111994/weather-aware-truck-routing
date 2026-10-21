"""Every error leaves the API as RFC 9457 ``problem+json``: stable codes, no leaks, no stack traces.

The probe URLconf (``tests/api/probe_urls.py``) fails on purpose in every way a Ninja operation or a
plain Django view can fail; the real middleware and the real handlers turn each failure into a
document. Nothing here touches the database.
"""

import json
import logging
import re
from typing import Any

import pytest
from django.http import HttpResponse
from django.http.response import HttpResponseBase
from django.test import Client
from pytest_django import Settings

from haulcast.api.errors import (
    MAX_REPORTED_FIELD_ERRORS,
    is_problem,
    normalize_error_response,
    payload_too_large,
    problem_for_status,
    render_problem,
)
from haulcast.problems import (
    PROBLEM_DOCS_URL,
    PROBLEM_MEDIA_TYPE,
    PROBLEMS,
    ProblemCode,
    ProblemError,
)
from tests.api.probe_urls import SECRET_DETAIL

UUID4 = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")


def problem_of(response: HttpResponseBase) -> dict[str, Any]:
    """Return the decoded problem document, asserting the invariants every error response has."""
    assert isinstance(response, HttpResponse)
    assert response["Content-Type"] == PROBLEM_MEDIA_TYPE
    assert response["Cache-Control"] == "no-store"
    text = response.content.decode()
    assert SECRET_DETAIL not in text
    assert "Traceback" not in text
    body = json.loads(text)
    assert body["status"] == response.status_code
    assert body["request_id"] == response["X-Request-ID"]
    return dict(body)


# --------------------------------------------------------------------------- ProblemError


@pytest.mark.parametrize("code", sorted(PROBLEMS))
def test_every_problem_code_renders_with_its_catalogue_semantics(
    probe_client: Client, code: ProblemCode
) -> None:
    response = probe_client.get("/probe/problem", {"code": code})

    body = problem_of(response)
    spec = PROBLEMS[code]
    assert response.status_code == spec.status
    assert body["code"] == code
    assert body["title"] == spec.title
    assert body["type"] == f"{PROBLEM_DOCS_URL}#{spec.anchor}"
    assert body["detail"] == "Detail written by our own code."
    assert "errors" not in body
    assert "Retry-After" not in response


def test_a_problem_documents_its_keys_in_a_stable_order(probe_client: Client) -> None:
    response = probe_client.get("/probe/problem", {"code": "plan_not_found"})

    assert list(json.loads(response.content)) == [
        "type",
        "title",
        "status",
        "detail",
        "code",
        "request_id",
    ]


@pytest.mark.parametrize(
    ("hint", "header"), [("0.2", "1"), ("1", "1"), ("1.2", "2"), ("30", "30"), ("59.01", "60")]
)
def test_retry_hints_become_whole_second_retry_after_headers(
    probe_client: Client, hint: str, header: str
) -> None:
    response = probe_client.get("/probe/problem", {"code": "rate_limited", "retry": hint})

    assert response["Retry-After"] == header


def test_a_problem_can_carry_a_list_of_field_errors(probe_client: Client) -> None:
    response = probe_client.get("/probe/problem-with-fields")

    body = problem_of(response)
    assert response.status_code == 422
    assert body["errors"] == [{"loc": ["query", "n"], "msg": "bad", "type": "value_error"}]


def test_a_problem_can_override_the_catalogue_status() -> None:
    error = ProblemError(ProblemCode.WEATHER_UNAVAILABLE, status=502)

    assert render_problem(error).status_code == 502
    assert PROBLEMS[ProblemCode.WEATHER_UNAVAILABLE].status == 503


def test_an_unknown_problem_code_is_a_programming_error() -> None:
    with pytest.raises(ValueError, match="definitely_not_a_code"):
        ProblemCode("definitely_not_a_code")


def test_a_problem_rendered_outside_a_request_has_the_placeholder_request_id() -> None:
    response = render_problem(ProblemError(ProblemCode.NOT_FOUND))

    assert json.loads(response.content)["request_id"] == "-"


# --------------------------------------------------------------------------- validation


def test_validation_errors_are_capped_and_summarised(probe_client: Client) -> None:
    response = probe_client.get("/probe/validation/many")

    body = problem_of(response)
    assert response.status_code == 422
    assert body["code"] == "validation_error"
    assert len(body["errors"]) == MAX_REPORTED_FIELD_ERRORS == 20
    assert body["errors"][0] == {
        "loc": ["query", "field0"],
        "msg": "problem 0",
        "type": "value_error",
    }
    assert body["detail"] == "field0: problem 0 (and 24 more)"


def test_validation_locations_are_normalised_for_clients(probe_client: Client) -> None:
    response = probe_client.get("/probe/validation/shapes")

    body = problem_of(response)
    assert [error["loc"] for error in body["errors"]] == [
        ["body", "items", 3, "name"],  # Ninja's body parameter name is dropped
        ["body", "origin", "lat"],
        ["query"],  # a scalar location becomes a one-element list
        ["body", "True", "x"],  # booleans are not array indexes
        [],  # no location at all
        ["body", "payload"],  # nothing follows the parameter name: kept as is
    ]
    assert [error["msg"] for error in body["errors"]][-2:] == ["m5", "Invalid value"]
    assert [error["type"] for error in body["errors"]][-2:] == ["", "t6"]
    assert body["detail"] == "items.3.name: m1 (and 5 more)"


def test_a_single_validation_error_has_no_and_n_more_suffix(probe_client: Client) -> None:
    body = problem_of(probe_client.get("/probe/validation/single"))

    assert body["detail"] == "q: too short"


def test_a_validation_error_without_a_field_path_reports_just_the_message(
    probe_client: Client,
) -> None:
    body = problem_of(probe_client.get("/probe/validation/no-loc"))

    assert body["detail"] == "whole body is wrong"
    assert body["errors"] == [{"loc": [], "msg": "whole body is wrong", "type": "value_error"}]


def test_a_validation_error_that_lists_nothing_has_no_detail_or_errors(
    probe_client: Client,
) -> None:
    body = problem_of(probe_client.get("/probe/validation/none"))

    assert body["code"] == "validation_error"
    assert "detail" not in body
    assert "errors" not in body


def test_ninja_body_validation_reports_the_field_not_the_parameter(probe_client: Client) -> None:
    response = probe_client.post(
        "/probe/echo", data={"number": "not-a-number"}, content_type="application/json"
    )

    body = problem_of(response)
    assert response.status_code == 422
    assert body["errors"][0]["loc"] == ["body", "number"]
    assert body["detail"].startswith("number: ")


def test_a_valid_body_round_trips(probe_client: Client) -> None:
    response = probe_client.post("/probe/echo", data={"number": 7}, content_type="application/json")

    assert response.status_code == 200
    assert response.json() == {"number": 7}


@pytest.mark.parametrize("raw", ["{", '{"number": ', "not json", "\x00\x01"])
def test_malformed_json_is_a_400_with_a_fixed_message(probe_client: Client, raw: str) -> None:
    response = probe_client.post("/probe/echo", data=raw, content_type="application/json")

    body = problem_of(response)
    assert response.status_code == 400
    assert body["code"] == "malformed_json"
    assert body["detail"] == "The request body is not valid JSON."


# --------------------------------------------------------------------------- Django + Ninja errors


def test_http404_inside_ninja_is_not_found(probe_client: Client) -> None:
    response = probe_client.get("/probe/not-found")

    body = problem_of(response)
    assert (response.status_code, body["code"]) == (404, "not_found")
    assert "detail" not in body


def test_request_data_too_big_names_the_configured_limit(probe_client: Client) -> None:
    response = probe_client.get("/probe/too-large")

    body = problem_of(response)
    assert (response.status_code, body["code"]) == (413, "payload_too_large")
    assert body["detail"] == "The request body exceeds 16 KiB."


def test_the_payload_limit_in_the_message_follows_the_setting(settings: Settings) -> None:
    settings.DATA_UPLOAD_MAX_MEMORY_SIZE = 3 * 1024

    assert payload_too_large().detail == "The request body exceeds 3 KiB."


def test_suspicious_operations_inside_ninja_are_plain_bad_requests(probe_client: Client) -> None:
    response = probe_client.get("/probe/suspicious")

    body = problem_of(response)
    assert (response.status_code, body["code"]) == (400, "bad_request")
    assert "detail" not in body


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (400, "bad_request"),
        (401, "unauthorized"),
        (403, "forbidden"),
        (404, "not_found"),
        (405, "method_not_allowed"),
        (413, "payload_too_large"),
        (422, "validation_error"),
        (429, "rate_limited"),
        (502, "bad_gateway"),
        (503, "service_unavailable"),
        (418, "bad_request"),
        (451, "bad_request"),
        (500, "internal_error"),
        (504, "internal_error"),
        (599, "internal_error"),
    ],
)
def test_ninja_http_errors_map_to_generic_problems_that_never_echo_the_message(
    probe_client: Client, status: int, code: str
) -> None:
    response = probe_client.get("/probe/http-error", {"status": status})

    body = problem_of(response)
    assert (response.status_code, body["code"]) == (status, code)
    assert "detail" not in body


def test_an_unexpected_exception_is_a_500_that_leaks_nothing_but_is_logged(
    probe_client: Client, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.ERROR, logger="haulcast.api"):
        response = probe_client.get("/probe/boom")

    body = problem_of(response)
    assert (response.status_code, body["code"]) == (500, "internal_error")
    assert "detail" not in body
    record = next(r for r in caplog.records if r.getMessage() == "unhandled_exception")
    assert record.exc_info is not None
    assert SECRET_DETAIL in caplog.text


# --------------------------------------------------------------------------- Django's own views


def test_an_unknown_url_is_a_not_found_problem(probe_client: Client) -> None:
    response = probe_client.get("/definitely/not/a/route")

    body = problem_of(response)
    assert (response.status_code, body["code"]) == (404, "not_found")


def test_a_crash_outside_ninja_is_a_500_problem(probe_client: Client) -> None:
    response = probe_client.get("/django/crash")

    body = problem_of(response)
    assert (response.status_code, body["code"]) == (500, "internal_error")


def test_a_suspicious_operation_outside_ninja_is_a_400_problem(probe_client: Client) -> None:
    response = probe_client.get("/django/suspicious")

    body = problem_of(response)
    assert (response.status_code, body["code"]) == (400, "bad_request")


def test_permission_denied_outside_ninja_is_a_403_problem(probe_client: Client) -> None:
    response = probe_client.get("/django/forbidden")

    body = problem_of(response)
    assert (response.status_code, body["code"]) == (403, "forbidden")


def test_a_bare_405_becomes_a_problem_and_keeps_the_allow_header(probe_client: Client) -> None:
    response = probe_client.get("/django/method-not-allowed")

    body = problem_of(response)
    assert (response.status_code, body["code"]) == (405, "method_not_allowed")
    assert response["Allow"] == "GET, HEAD"


def test_a_bare_503_becomes_a_problem_and_keeps_its_retry_after(probe_client: Client) -> None:
    response = probe_client.get("/django/unavailable")

    body = problem_of(response)
    assert (response.status_code, body["code"]) == (503, "service_unavailable")
    assert response["Retry-After"] == "7"


def test_a_bare_401_becomes_a_problem_and_keeps_its_challenge(probe_client: Client) -> None:
    response = probe_client.get("/django/unauthorized")

    body = problem_of(response)
    assert (response.status_code, body["code"]) == (401, "unauthorized")
    assert response["WWW-Authenticate"] == 'Bearer realm="probe"'


@pytest.mark.parametrize(("status", "code"), [(418, "bad_request"), (599, "internal_error")])
def test_bare_error_statuses_without_a_catalogue_entry_keep_their_status(
    probe_client: Client, status: int, code: str
) -> None:
    response = probe_client.get(f"/django/status/{status}")

    body = problem_of(response)
    assert (response.status_code, body["code"]) == (status, code)


def test_successful_responses_are_never_rewritten(probe_client: Client) -> None:
    response = probe_client.get("/django/ok")

    assert response.status_code == 200
    assert response.content == b"fine"
    assert response["Cache-Control"] == "public, max-age=60"


# --------------------------------------------------------------------------- helpers


@pytest.mark.parametrize(
    ("content_type", "expected"),
    [
        ("application/problem+json", True),
        ("application/problem+json; charset=utf-8", True),
        ("application/json", False),
        ("text/plain", False),
        ("text/html; charset=utf-8", False),
    ],
)
def test_is_problem_looks_at_the_media_type_only(content_type: str, *, expected: bool) -> None:
    assert is_problem(HttpResponse("{}", content_type=content_type)) is expected


def test_normalizing_keeps_only_routing_headers() -> None:
    original = HttpResponse(SECRET_DETAIL, status=503, content_type="text/plain")
    original["Retry-After"] = "9"
    original["X-Internal"] = "kept-out"

    rewritten = normalize_error_response(original)

    assert rewritten.status_code == 503
    assert rewritten["Retry-After"] == "9"
    assert "X-Internal" not in rewritten
    assert SECRET_DETAIL not in rewritten.content.decode()


@pytest.mark.parametrize("status", [400, 401, 403, 404, 405, 413, 422, 429, 502, 503])
def test_generic_problems_keep_the_status_they_stand_for(status: int) -> None:
    assert problem_for_status(status).status == status
