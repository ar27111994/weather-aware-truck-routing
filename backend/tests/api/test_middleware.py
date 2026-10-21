"""The request-level middleware: request identity, response hardening, guards and the access log.

Runs against the probe URLconf behind the real middleware (no rate limiter, no database).
"""

import json
import logging
import re
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from django.test import Client
from pytest_django import Settings

from haulcast.api.middleware import (
    PUBLIC_CORS_PATHS,
    REQUEST_ID_HEADER,
    accept_or_generate_request_id,
)
from haulcast.log import EXTRA_FIELDS, JsonFormatter
from haulcast.observability import REQUEST_ID_UNSET, current_request_id
from tests.api.probe_urls import SECRET_DETAIL

MAX_BODY = 16 * 1024


def _json_body(size: int) -> bytes:
    """A valid ``/probe/echo`` body of exactly ``size`` bytes."""
    document = b'{"number": 1}'
    return document + b" " * (size - len(document))


# --------------------------------------------------------------------------- request id


@pytest.mark.parametrize("inbound", ["abcd-1234", "A" * 8, "a" * 64, "0123456789-ABCDEF-xyz"])
def test_a_well_formed_inbound_request_id_is_kept_and_echoed(
    probe_client: Client, inbound: str
) -> None:
    response = probe_client.get("/probe/ok", headers={REQUEST_ID_HEADER: inbound})

    assert response[REQUEST_ID_HEADER] == inbound


@pytest.mark.parametrize(
    "inbound",
    [
        "",
        "short",
        "a" * 7,
        "a" * 65,
        "has space inside",
        "under_score_id",
        "ünïcode-request-id",
        "id;DROP",
    ],
)
def test_a_malformed_inbound_request_id_is_replaced_by_a_fresh_uuid(
    probe_client: Client, inbound: str
) -> None:
    response = probe_client.get("/probe/ok", headers={REQUEST_ID_HEADER: inbound})

    assert response[REQUEST_ID_HEADER] != inbound
    assert uuid.UUID(response[REQUEST_ID_HEADER]).version == 4


def test_every_response_without_an_inbound_id_gets_its_own_uuid(probe_client: Client) -> None:
    first = probe_client.get("/probe/ok")[REQUEST_ID_HEADER]
    second = probe_client.get("/probe/ok")[REQUEST_ID_HEADER]

    assert first != second
    assert uuid.UUID(first).version == uuid.UUID(second).version == 4


def test_the_request_id_of_an_error_body_matches_its_header(probe_client: Client) -> None:
    response = probe_client.get(
        "/probe/problem", {"code": "bad_request"}, headers={REQUEST_ID_HEADER: "trace-0001-abcd"}
    )

    assert response.json()["request_id"] == "trace-0001-abcd" == response[REQUEST_ID_HEADER]


def test_the_request_id_does_not_outlive_the_request(probe_client: Client) -> None:
    probe_client.get("/probe/ok", headers={REQUEST_ID_HEADER: "trace-0002-abcd"})

    assert current_request_id() == REQUEST_ID_UNSET


def test_accept_or_generate_request_id_is_a_pure_function_of_its_input() -> None:
    assert accept_or_generate_request_id("valid-id-0001") == "valid-id-0001"
    assert accept_or_generate_request_id(None) != accept_or_generate_request_id(None)
    assert re.fullmatch(r"[0-9a-f-]{36}", accept_or_generate_request_id("bad id"))


# --------------------------------------------------------------------------- headers


def test_every_response_carries_the_security_headers(probe_client: Client) -> None:
    response = probe_client.get("/probe/ok")

    assert response["X-Content-Type-Options"] == "nosniff"
    assert response["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert response["Cross-Origin-Resource-Policy"] == "same-origin"
    assert "Access-Control-Allow-Origin" not in response
    assert response["Content-Type"] == "application/json; charset=utf-8"


def test_error_responses_carry_the_same_security_headers(probe_client: Client) -> None:
    response = probe_client.get("/probe/boom")

    assert response["X-Content-Type-Options"] == "nosniff"
    assert response["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert response["Cross-Origin-Resource-Policy"] == "same-origin"
    assert response["Cache-Control"] == "no-store"


def test_a_success_without_its_own_cache_policy_is_no_store(probe_client: Client) -> None:
    assert probe_client.get("/probe/ok")["Cache-Control"] == "no-store"


def test_a_success_that_sets_its_own_cache_policy_keeps_it(probe_client: Client) -> None:
    assert probe_client.get("/django/ok")["Cache-Control"] == "public, max-age=60"


def test_a_head_request_mirrors_the_cache_policy_of_its_get(probe_client: Client) -> None:
    assert probe_client.head("/django/ok")["Cache-Control"] == "public, max-age=60"


def test_posts_are_never_cached(probe_client: Client) -> None:
    response = probe_client.post("/probe/echo", data={"number": 1}, content_type="application/json")

    assert response.status_code == 200
    assert response["Cache-Control"] == "no-store"


def test_errors_are_never_cached_even_when_the_route_set_a_policy(probe_client: Client) -> None:
    response = probe_client.get("/django/status/418")

    assert response["Cache-Control"] == "no-store"


@pytest.mark.parametrize("path", sorted(PUBLIC_CORS_PATHS))
@pytest.mark.parametrize("method", ["get", "head"])
def test_only_the_rules_and_openapi_documents_answer_cross_origin_reads(
    probe_client: Client, path: str, method: str
) -> None:
    response = getattr(probe_client, method)(path, headers={"Origin": "https://elsewhere.example"})

    assert response["Access-Control-Allow-Origin"] == "*"
    assert response["Cross-Origin-Resource-Policy"] == "cross-origin"


@pytest.mark.parametrize(
    "path", ["/api/v1/rules/", "/api/v1/rules-extra", "/probe/ok", "/django/ok"]
)
def test_every_other_path_stays_same_origin(probe_client: Client, path: str) -> None:
    response = probe_client.get(path, headers={"Origin": "https://elsewhere.example"})

    assert "Access-Control-Allow-Origin" not in response
    assert response["Cross-Origin-Resource-Policy"] == "same-origin"


def test_the_query_string_does_not_make_a_path_public_or_private(probe_client: Client) -> None:
    assert probe_client.get("/api/v1/rules?x=1")["Access-Control-Allow-Origin"] == "*"


def test_posts_to_a_public_path_are_not_cross_origin_readable(probe_client: Client) -> None:
    response = probe_client.post("/api/v1/rules", data="{}", content_type="application/json")

    assert "Access-Control-Allow-Origin" not in response
    assert response["Cross-Origin-Resource-Policy"] == "same-origin"


# --------------------------------------------------------------------------- host


def test_a_disallowed_host_is_a_400_problem_with_headers_and_an_id(probe_client: Client) -> None:
    response = probe_client.get("/probe/ok", headers={"Host": "evil.example"})

    body = response.json()
    assert response.status_code == 400
    assert response["Content-Type"] == "application/problem+json"
    assert body["code"] == "bad_request"
    assert body["detail"] == "Invalid Host header."
    assert body["request_id"] == response[REQUEST_ID_HEADER]
    assert response["X-Content-Type-Options"] == "nosniff"
    assert "evil.example" not in response.content.decode()


# --------------------------------------------------------------------------- guards


def test_post_bodies_must_be_json(probe_client: Client) -> None:
    response = probe_client.post("/probe/echo", data="a=1", content_type="text/plain")

    body = response.json()
    assert response.status_code == 400
    assert body["code"] == "invalid_content_type"
    assert body["detail"] == "Send the body as application/json."


@pytest.mark.parametrize(
    "content_type", ["application/json", "application/json; charset=utf-8", "Application/JSON"]
)
def test_json_content_types_are_accepted_with_parameters_and_any_case(
    probe_client: Client, content_type: str
) -> None:
    response = probe_client.post("/probe/echo", data='{"number": 5}', content_type=content_type)

    assert response.status_code == 200


def test_a_form_post_is_refused(probe_client: Client) -> None:
    response = probe_client.post("/probe/echo", data={"number": "1"})

    assert response.status_code == 400
    assert response.json()["code"] == "invalid_content_type"


@pytest.mark.parametrize("method", ["put", "patch", "delete"])
def test_every_unsafe_method_is_guarded(probe_client: Client, method: str) -> None:
    response = getattr(probe_client, method)("/probe/echo", data="{}", content_type="text/plain")

    assert response.status_code == 400
    assert response.json()["code"] == "invalid_content_type"


@pytest.mark.parametrize("method", ["get", "head", "options"])
def test_safe_methods_skip_the_body_guards(probe_client: Client, method: str) -> None:
    response = getattr(probe_client, method)(
        "/probe/ok", headers={"Origin": "https://evil.example"}, content_type="text/plain"
    )

    assert response.status_code in {200, 405}


def test_a_body_over_sixteen_kibibytes_is_a_413_before_it_is_read(probe_client: Client) -> None:
    response = probe_client.post(
        "/probe/echo", data=_json_body(MAX_BODY + 1), content_type="application/json"
    )

    body = response.json()
    assert response.status_code == 413
    assert body["code"] == "payload_too_large"
    assert body["detail"] == "The request body exceeds 16 KiB."


def test_a_body_of_exactly_sixteen_kibibytes_is_accepted(probe_client: Client) -> None:
    response = probe_client.post(
        "/probe/echo", data=_json_body(MAX_BODY), content_type="application/json"
    )

    assert response.status_code == 200


def test_an_undeclared_body_length_skips_the_declared_size_check(probe_client: Client) -> None:
    response = probe_client.post(
        "/probe/echo", data=_json_body(64), content_type="application/json", CONTENT_LENGTH=""
    )

    # The guard let it through; Django then reads an empty body, which Ninja rejects as invalid.
    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


def test_the_size_limit_follows_the_setting(probe_client: Client, settings: Settings) -> None:
    settings.DATA_UPLOAD_MAX_MEMORY_SIZE = 100

    response = probe_client.post(
        "/probe/echo", data=_json_body(101), content_type="application/json"
    )

    assert response.status_code == 413
    assert response.json()["detail"] == "The request body exceeds 0 KiB."


def test_a_foreign_origin_cannot_post(probe_client: Client) -> None:
    response = probe_client.post(
        "/probe/echo",
        data='{"number": 1}',
        content_type="application/json",
        headers={"Origin": "https://evil.example"},
    )

    body = response.json()
    assert response.status_code == 403
    assert body["code"] == "origin_not_allowed"
    assert body["detail"] == "Cross-origin requests are not allowed."


@pytest.mark.parametrize(
    "origin", ["http://testserver", "https://testserver", "HTTP://TESTSERVER", "http://testserver/"]
)
def test_the_apis_own_origin_may_post(probe_client: Client, origin: str) -> None:
    response = probe_client.post(
        "/probe/echo",
        data='{"number": 1}',
        content_type="application/json",
        headers={"Origin": origin},
    )

    assert response.status_code == 200


def test_a_post_without_an_origin_header_is_a_non_browser_client_and_passes(
    probe_client: Client,
) -> None:
    response = probe_client.post(
        "/probe/echo", data='{"number": 1}', content_type="application/json"
    )

    assert response.status_code == 200


@pytest.mark.parametrize(
    "origin",
    [
        "null",
        "",
        "file:///etc/passwd",
        "ftp://testserver",
        "http://",
        "http://testserver.evil.example",
        "http://evil.example/http://testserver",
        "http://testserver:8000",
        "javascript:alert(1)",
    ],
)
def test_malformed_and_lookalike_origins_are_refused(probe_client: Client, origin: str) -> None:
    response = probe_client.post(
        "/probe/echo",
        data='{"number": 1}',
        content_type="application/json",
        headers={"Origin": origin},
    )

    assert response.status_code == 403
    assert response.json()["code"] == "origin_not_allowed"


def test_explicitly_allowed_origins_may_post_in_any_case(
    probe_client: Client, settings: Settings
) -> None:
    settings.HAULCAST_ALLOWED_ORIGINS = ("https://app.example", "http://localhost:5173")

    def post(origin: str) -> int:
        return probe_client.post(
            "/probe/echo",
            data='{"number": 1}',
            content_type="application/json",
            headers={"Origin": origin},
        ).status_code

    assert post("https://APP.example/") == 200
    assert post("http://localhost:5173") == 200
    assert post("https://app.example:8443") == 403
    assert post("http://app.example") == 403


def test_the_guards_fire_in_a_fixed_order_size_then_origin_then_content_type(
    probe_client: Client,
) -> None:
    def post(data: bytes | str, headers: dict[str, str]) -> tuple[int, str]:
        response = probe_client.post(
            "/probe/echo", data=data, content_type="text/plain", headers=headers
        )
        return response.status_code, response.json()["code"]

    foreign = {"Origin": "https://evil.example"}
    assert post(_json_body(MAX_BODY + 1), foreign) == (413, "payload_too_large")
    assert post("x", foreign) == (403, "origin_not_allowed")
    assert post(_json_body(MAX_BODY + 1), {}) == (413, "payload_too_large")
    assert post("x", {}) == (400, "invalid_content_type")


def test_guard_failures_still_carry_ids_and_security_headers(probe_client: Client) -> None:
    response = probe_client.post("/probe/echo", data="a=1", content_type="text/plain")

    assert response[REQUEST_ID_HEADER] == response.json()["request_id"]
    assert response["X-Content-Type-Options"] == "nosniff"
    assert response["Cache-Control"] == "no-store"
    assert SECRET_DETAIL not in response.content.decode()


# --------------------------------------------------------------------------- access log


def _access_records(caplog: pytest.LogCaptureFixture) -> list[dict[str, Any]]:
    """The structured fields of every access-log record (the allow-listed ``extra`` values)."""
    return [
        {name: record.__dict__[name] for name in EXTRA_FIELDS if name in record.__dict__}
        for record in caplog.records
        if record.name == "haulcast.api.access"
    ]


def test_the_access_log_summarises_latency_cache_and_upstream_timings(
    probe_client: Client, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger="haulcast.api.access"):
        probe_client.get("/probe/ok")

    (fields,) = _access_records(caplog)
    assert fields["event"] == "request"
    assert (fields["method"], fields["path"], fields["status"]) == ("GET", "/probe/ok", 200)
    assert isinstance(fields["latency_ms"], float)
    assert fields["latency_ms"] >= 0
    assert fields["cache"] == "mixed"
    assert fields["upstream"] == [{"provider": "probe-upstream", "outcome": "http_200", "ms": 12.3}]


@pytest.mark.parametrize(
    ("path", "cache", "upstream"),
    [("/probe/ok-no-metrics", "none", []), ("/probe/cache-hits", "hit", [])],
)
def test_the_access_log_collapses_cache_outcomes(
    probe_client: Client,
    caplog: pytest.LogCaptureFixture,
    path: str,
    cache: str,
    upstream: list[object],
) -> None:
    with caplog.at_level(logging.INFO, logger="haulcast.api.access"):
        probe_client.get(path)

    (fields,) = _access_records(caplog)
    assert (fields["cache"], fields["upstream"]) == (cache, upstream)


def test_the_access_log_records_the_status_of_errors(
    probe_client: Client, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger="haulcast.api.access"):
        probe_client.get("/probe/problem", {"code": "rate_limited"})

    (fields,) = _access_records(caplog)
    assert fields["status"] == 429


def test_the_access_log_never_contains_query_strings_addresses_or_bodies(
    probe_client: Client, caplog: pytest.LogCaptureFixture
) -> None:
    secret = "query-secret-" + "value"
    with caplog.at_level(logging.INFO, logger="haulcast.api.access"):
        probe_client.get(
            f"/probe/ok?token={secret}",
            REMOTE_ADDR="203.0.113.77",
            HTTP_X_FORWARDED_FOR="198.51.100.1",
        )
        probe_client.post(
            "/probe/echo",
            data={"number": 123456789},
            content_type="application/json",
            REMOTE_ADDR="203.0.113.78",
        )

    records = _access_records(caplog)
    assert [record["path"] for record in records] == ["/probe/ok", "/probe/echo"]
    for rendered in (caplog.text, repr(records)):
        for leak in (secret, "203.0.113.77", "203.0.113.78", "198.51.100.1", "123456789"):
            assert leak not in rendered
    assert set().union(*records) <= set(EXTRA_FIELDS)


def test_a_disallowed_host_is_logged_as_a_400(
    probe_client: Client, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger="haulcast.api.access"):
        probe_client.get("/probe/ok", headers={"Host": "evil.example"})

    (fields,) = _access_records(caplog)
    assert fields["status"] == 400
    assert "evil.example" not in caplog.text


class _EmitTimeJsonHandler(logging.Handler):
    """Renders each record with the production formatter *while it is emitted*.

    The stdout handler formats synchronously inside ``logger.info``, and ``JsonFormatter`` reads the
    request id from the context at that moment. ``caplog`` stores the record and formats it later,
    after the request id has been reset, so it cannot see the defect these tests are about.
    """

    def __init__(self) -> None:
        super().__init__()
        self.setFormatter(JsonFormatter())
        self.lines: list[dict[str, Any]] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(json.loads(self.format(record)))


@pytest.fixture
def emitted_access_lines() -> Iterator[list[dict[str, Any]]]:
    """The JSON lines the access logger emits during a test, formatted as on stdout."""
    handler = _EmitTimeJsonHandler()
    logger = logging.getLogger("haulcast.api.access")
    previous_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    try:
        yield handler.lines
    finally:
        logger.removeHandler(handler)
        logger.setLevel(previous_level)


def test_the_access_log_line_carries_the_id_of_the_inbound_request(
    probe_client: Client, emitted_access_lines: list[dict[str, Any]]
) -> None:
    response = probe_client.get("/probe/ok", headers={REQUEST_ID_HEADER: "abcd-1234-feed"})

    (line,) = emitted_access_lines
    assert response[REQUEST_ID_HEADER] == "abcd-1234-feed"
    assert line["request_id"] == response[REQUEST_ID_HEADER]


def test_the_access_log_line_carries_the_generated_id_of_its_response(
    probe_client: Client, emitted_access_lines: list[dict[str, Any]]
) -> None:
    response = probe_client.get("/probe/ok")

    (line,) = emitted_access_lines
    assert line["request_id"] == response[REQUEST_ID_HEADER] != REQUEST_ID_UNSET
    assert uuid.UUID(line["request_id"]).version == 4


@pytest.mark.parametrize(
    ("method", "url", "status"),
    [
        ("get", "/probe/problem?code=rate_limited", 429),
        ("get", "/probe/boom", 500),
        ("get", "/django/crash", 500),
        ("get", "/probe/not-found", 404),
        ("post", "/probe/echo", 400),
    ],
)
def test_the_access_log_line_of_an_error_carries_the_id_of_its_problem_body(
    probe_client: Client,
    emitted_access_lines: list[dict[str, Any]],
    method: str,
    url: str,
    status: int,
) -> None:
    response = getattr(probe_client, method)(url)

    (line,) = emitted_access_lines
    assert response.status_code == status
    assert line["status"] == status
    assert line["request_id"] == response[REQUEST_ID_HEADER] == response.json()["request_id"]
