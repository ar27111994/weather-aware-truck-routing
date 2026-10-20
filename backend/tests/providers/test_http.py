"""The shared outbound HTTP plumbing: client construction, retry policy and failure mapping."""

import json
from collections.abc import Callable, Iterator

import httpx
import pytest

from haulcast import __version__
from haulcast.providers.errors import (
    ProviderRateLimitedError,
    ProviderRejectedError,
    ProviderResponseError,
    ProviderUnavailableError,
)
from haulcast.providers.http import (
    REPOSITORY_URL,
    USER_AGENT,
    HttpPolicy,
    JsonRequest,
    UpstreamClient,
    build_client,
    parse_retry_after,
)

URL = "https://upstream.test/v1/things"
NAME = "test-upstream"
DOCUMENT = {"ok": True}

Handler = Callable[[], httpx.Response]


def make(
    handler: Handler, policy: HttpPolicy | None = None
) -> tuple[UpstreamClient, list[httpx.Request], list[float]]:
    """An ``UpstreamClient`` over a mock transport, plus the requests it sent and its sleeps.

    Jitter is pinned to 0.5, so a backoff is exactly half of its ceiling.
    """
    chosen = policy or HttpPolicy()
    requests: list[httpx.Request] = []
    sleeps: list[float] = []

    def recording(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler()

    client = build_client(policy=chosen, transport=httpx.MockTransport(recording))
    upstream = UpstreamClient(
        NAME, client=client, policy=chosen, sleep=sleeps.append, random_fn=lambda: 0.5
    )
    return upstream, requests, sleeps


def sequence(*outcomes: httpx.Response | Exception) -> Handler:
    """A handler that answers with each outcome in turn, raising the ones that are exceptions."""
    remaining = iter(outcomes)

    def handler() -> httpx.Response:
        outcome = next(remaining)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    return handler


class RawBody(httpx.SyncByteStream):
    """A body streamed lazily and undecoded, the way it arrives from the network.

    ``httpx.Response(content=...)`` would decode eagerly in its constructor, so a corrupt
    ``Content-Encoding`` body must be streamed to reach the code under test.
    """

    def __init__(self, data: bytes) -> None:
        self._data = data

    def __iter__(self) -> Iterator[bytes]:
        yield self._data


def ok() -> httpx.Response:
    """A successful JSON answer."""
    return httpx.Response(200, json=DOCUMENT)


# --------------------------------------------------------------------------- the client


def test_the_client_identifies_the_application_and_sets_the_documented_timeouts() -> None:
    client = build_client(headers={"X-Client-Id": "haulcast"})

    assert f"Haulcast/{__version__} (+{REPOSITORY_URL})" == USER_AGENT
    assert client.headers["User-Agent"] == USER_AGENT
    assert client.headers["Accept"] == "application/json"
    assert client.headers["X-Client-Id"] == "haulcast"
    assert (client.timeout.connect, client.timeout.read) == (3.0, 8.0)


def test_a_redirect_is_an_error_and_is_never_followed() -> None:
    redirect = httpx.Response(302, headers={"Location": "https://evil.test/steal"})
    upstream, requests, _ = make(sequence(redirect))

    with pytest.raises(ProviderResponseError) as raised:
        upstream.get_json(URL)

    assert raised.value.message == "unexpected HTTP 302"
    assert [str(request.url) for request in requests] == [URL]


# --------------------------------------------------------------------------- Retry-After


@pytest.mark.parametrize(
    ("headers", "seconds"),
    [
        ({"Retry-After": "30"}, 30.0),
        ({"retry-after": " 7.5 "}, 7.5),
        ({"RETRY-AFTER": "0"}, 0.0),
        ({}, None),
        ({"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}, None),
        ({"Retry-After": "soon"}, None),
        ({"Retry-After": ""}, None),
        ({"Retry-After": "-5"}, None),
        ({"Retry-After": "nan"}, None),
        ({"Retry-After": "inf"}, None),
    ],
    ids=[
        "seconds",
        "padded-fraction",
        "zero",
        "absent",
        "http-date",
        "word",
        "empty",
        "negative",
        "not-a-number",
        "infinite",
    ],
)
def test_retry_after_is_a_finite_non_negative_number_of_seconds_or_unknown(
    headers: dict[str, str], seconds: float | None
) -> None:
    assert parse_retry_after(headers) == seconds


# --------------------------------------------------------------------------- 4xx mapping


@pytest.mark.parametrize(
    ("response", "message", "code"),
    [
        (httpx.Response(400, content=b"<html>bad request</html>"), "HTTP 400", None),
        (httpx.Response(400, content=b""), "HTTP 400", None),
        (httpx.Response(400, json=["not", "an", "object"]), "HTTP 400", None),
        (
            httpx.Response(
                400, json={"error_code": 154, "error": "Path distance exceeds the max distance"}
            ),
            "HTTP 400: Path distance exceeds the max distance",
            "154",
        ),
        (
            httpx.Response(422, json={"code": "bad_input", "message": "nope"}),
            "HTTP 422: nope",
            "bad_input",
        ),
        (httpx.Response(404, json={"reason": "no such place"}), "HTTP 404: no such place", None),
        (httpx.Response(400, json={"error_code": True, "error": "x"}), "HTTP 400: x", None),
        (httpx.Response(400, json={"error": 12, "message": None}), "HTTP 400", None),
    ],
    ids=["html", "empty", "array", "error-code", "code-message", "reason", "bool-code", "no-text"],
)
def test_a_client_error_is_a_rejection_whatever_shape_its_body_has(
    response: httpx.Response, message: str, code: str | None
) -> None:
    upstream, requests, sleeps = make(sequence(response))

    with pytest.raises(ProviderRejectedError) as raised:
        upstream.get_json(URL)

    assert (raised.value.status, raised.value.code, raised.value.message) == (
        response.status_code,
        code,
        message,
    )
    assert str(raised.value) == f"{NAME}: {message}"
    assert len(requests) == 1  # repeating a rejected request is pointless
    assert sleeps == []


def test_upstream_text_is_made_printable_and_capped_before_it_reaches_a_message() -> None:
    hostile = "boom\n\x1b[31mred" + "y" * 300
    upstream, _, _ = make(sequence(httpx.Response(403, json={"error": hostile})))

    with pytest.raises(ProviderRejectedError) as raised:
        upstream.get_json(URL)

    assert raised.value.message == "HTTP 403: boom[31mred" + "y" * 149
    assert "\n" not in raised.value.message
    assert "\x1b" not in raised.value.message


# --------------------------------------------------------------------------- bodies


def test_a_body_exactly_at_the_size_cap_is_accepted_and_one_byte_more_is_refused() -> None:
    policy = HttpPolicy(max_response_bytes=100)
    fits = b'{"k":"' + b"x" * 92 + b'"}'
    too_big = b'{"k":"' + b"x" * 93 + b'"}'
    assert (len(fits), len(too_big)) == (100, 101)

    accepted, _, _ = make(sequence(httpx.Response(200, content=fits)), policy)
    refused, _, _ = make(sequence(httpx.Response(200, content=too_big)), policy)

    assert accepted.get_json(URL) == {"k": "x" * 92}
    with pytest.raises(ProviderResponseError, match="larger than 100 bytes"):
        refused.get_json(URL)


def test_a_body_that_cannot_be_decompressed_is_a_response_error() -> None:
    corrupt = httpx.Response(
        200, headers={"Content-Encoding": "gzip"}, stream=RawBody(b"not gzip at all")
    )
    upstream, _, _ = make(sequence(corrupt))

    with pytest.raises(ProviderResponseError) as raised:
        upstream.get_json(URL)

    assert raised.value.message == "undecodable response body"
    assert isinstance(raised.value.__cause__, httpx.DecodingError)


@pytest.mark.parametrize(
    "body", [b"", b"not json", b"\xff\xfe\x00"], ids=["empty", "text", "binary"]
)
def test_a_success_status_with_a_body_that_is_not_json_is_a_response_error(body: bytes) -> None:
    upstream, _, _ = make(sequence(httpx.Response(200, content=body)))

    with pytest.raises(ProviderResponseError, match="not valid JSON"):
        upstream.get_json(URL)


# --------------------------------------------------------------------------- retries


def test_a_server_error_is_retried_twice_with_full_jitter_backoff() -> None:
    upstream, requests, sleeps = make(sequence(httpx.Response(503), httpx.Response(502), ok()))

    assert upstream.get_json(URL) == DOCUMENT
    assert len(requests) == 3
    assert sleeps == [0.125, 0.25]  # ceilings 0.25 s then 0.5 s, jitter pinned to one half


def test_a_server_error_that_outlasts_the_retry_budget_surfaces_with_the_upstreams_hint() -> None:
    answers = [
        httpx.Response(503),
        httpx.Response(503),
        httpx.Response(503, headers={"Retry-After": "4"}),
    ]
    upstream, requests, sleeps = make(sequence(*answers))

    with pytest.raises(ProviderUnavailableError) as raised:
        upstream.get_json(URL)

    assert (raised.value.message, raised.value.retry_after_s) == ("HTTP 503", 4.0)
    assert not isinstance(raised.value, ProviderRateLimitedError)
    assert len(requests) == 3
    assert len(sleeps) == 2


def test_an_upstream_that_names_a_short_wait_is_waited_for_exactly() -> None:
    slow = httpx.Response(503, headers={"Retry-After": "2"})
    upstream, _, sleeps = make(sequence(slow, ok()))

    assert upstream.get_json(URL) == DOCUMENT
    assert sleeps == [2.0]


def test_an_upstream_that_asks_for_too_long_a_wait_is_not_waited_for() -> None:
    far = httpx.Response(503, headers={"Retry-After": "60"})
    upstream, requests, sleeps = make(sequence(far, ok()))

    with pytest.raises(ProviderUnavailableError) as raised:
        upstream.get_json(URL)

    assert raised.value.retry_after_s == 60.0
    assert len(requests) == 1
    assert sleeps == []


def test_one_rate_limit_answer_is_retried_and_a_second_surfaces() -> None:
    limited = httpx.Response(429, headers={"Retry-After": "1"})
    again = httpx.Response(429, headers={"Retry-After": "3"})
    recovers, _, recover_sleeps = make(sequence(limited, ok()))
    refused, requests, refuse_sleeps = make(sequence(limited, again, ok()))

    assert recovers.get_json(URL) == DOCUMENT
    assert recover_sleeps == [1.0]
    with pytest.raises(ProviderRateLimitedError) as raised:
        refused.get_json(URL)
    assert raised.value.retry_after_s == 3.0
    assert len(requests) == 2
    assert refuse_sleeps == [1.0]


def test_a_rate_limit_answer_without_a_hint_is_retried_after_a_jittered_backoff() -> None:
    upstream, _, sleeps = make(sequence(httpx.Response(429), ok()))

    assert upstream.get_json(URL) == DOCUMENT
    assert sleeps == [0.125]


def test_a_rate_limit_answer_that_asks_for_too_long_a_wait_surfaces_at_once() -> None:
    upstream, requests, sleeps = make(sequence(httpx.Response(429, headers={"Retry-After": "60"})))

    with pytest.raises(ProviderRateLimitedError) as raised:
        upstream.get_json(URL)

    assert raised.value.retry_after_s == 60.0
    assert (len(requests), sleeps) == (1, [])


@pytest.mark.parametrize(
    ("failure", "reason"),
    [
        (httpx.ReadTimeout("slow"), "timed out"),
        (httpx.ConnectTimeout("slow"), "timed out"),
        (httpx.ConnectError("refused"), "connection failed"),
        (httpx.RemoteProtocolError("garbled"), "connection failed"),
    ],
    ids=["read-timeout", "connect-timeout", "connect-error", "protocol-error"],
)
def test_transport_failures_are_retried_then_reported_without_upstream_detail(
    failure: Exception, reason: str
) -> None:
    upstream, requests, sleeps = make(sequence(failure, failure, failure))

    with pytest.raises(ProviderUnavailableError) as raised:
        upstream.get_json(URL)

    assert raised.value.message == reason
    assert raised.value.__cause__ is failure
    assert len(requests) == 3
    assert sleeps == [0.125, 0.25]


def test_a_transport_failure_that_clears_up_is_invisible_to_the_caller() -> None:
    upstream, _, sleeps = make(sequence(httpx.ConnectError("blip"), ok()))

    assert upstream.get_json(URL) == DOCUMENT
    assert sleeps == [0.125]


def test_a_request_that_is_not_idempotent_is_never_repeated() -> None:
    write = JsonRequest("POST", URL, json_body={"a": 1}, idempotent=False)
    for outcome in (httpx.Response(503), httpx.Response(429), httpx.ReadTimeout("slow")):
        upstream, requests, sleeps = make(sequence(outcome, ok()))

        with pytest.raises(ProviderUnavailableError):
            upstream.request_json(write)

        assert (len(requests), sleeps) == (1, [])


# --------------------------------------------------------------------------- request shapes


def test_get_sends_the_parameters_and_headers_it_was_given() -> None:
    upstream, requests, _ = make(sequence(ok()))

    upstream.get_json(URL, params={"q": "a b", "limit": 3}, headers={"X-Extra": "1"})

    request = requests[0]
    assert (request.method, request.url.params["q"], request.url.params["limit"]) == (
        "GET",
        "a b",
        "3",
    )
    assert request.headers["X-Extra"] == "1"
    assert request.headers["User-Agent"] == USER_AGENT


def test_post_json_sends_a_json_body() -> None:
    upstream, requests, _ = make(sequence(ok()))

    upstream.post_json(URL, body={"locations": [1, 2]})

    request = requests[0]
    assert request.method == "POST"
    assert request.headers["Content-Type"] == "application/json"
    assert json.loads(request.content) == {"locations": [1, 2]}


def test_post_form_sends_a_url_encoded_form() -> None:
    upstream, requests, _ = make(sequence(ok()))

    upstream.post_form(URL, form={"latitude": "39.7", "timezone": "GMT"})

    request = requests[0]
    assert request.method == "POST"
    assert request.headers["Content-Type"] == "application/x-www-form-urlencoded"
    assert request.content == b"latitude=39.7&timezone=GMT"
