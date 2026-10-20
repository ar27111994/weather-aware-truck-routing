"""The shared HTTP client under a request deadline, and its per-attempt hook.

The deadline is one budget for the whole request (R2-03); the hook is where an adapter spends a
shared allowance or waits for a minimum interval before *each* attempt, retries included (R2-04,
R2-19, R2-23). A controllable clock stands in for time: sleeping moves it, so a test can say "this
body arrives one second at a time" without waiting.
"""

from collections.abc import Callable, Iterator

import httpx
import pytest

from haulcast.providers.deadline import deadline_scope
from haulcast.providers.errors import (
    DeadlineExceededError,
    ProviderRateLimitedError,
    ProviderUnavailableError,
    UpstreamBudgetExhaustedError,
)
from haulcast.providers.http import HttpPolicy, JsonRequest, Pacing, UpstreamClient, build_client
from tests.providers.test_http import DOCUMENT, NAME, URL, ok


class Clock:
    """One clock for the deadline, the client and its sleeper, so waiting moves time."""

    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


def timed(
    handler: Callable[[httpx.Request], httpx.Response],
    clock: Clock,
    *,
    policy: HttpPolicy | None = None,
    before_attempt: Callable[[int], None] | None = None,
) -> UpstreamClient:
    chosen = policy or HttpPolicy()
    client = build_client(policy=chosen, transport=httpx.MockTransport(handler))
    return UpstreamClient(
        NAME,
        client=client,
        policy=chosen,
        pacing=Pacing(sleep=clock.sleep, jitter=lambda: 0.5, clock=clock),
        before_attempt=before_attempt,
    )


def timeouts_of(request: httpx.Request) -> dict[str, float | None]:
    return dict(request.extensions["timeout"])


# --------------------------------------------------------------------------- the deadline


def test_an_attempt_is_never_allowed_more_time_than_the_request_has_left() -> None:
    clock = Clock()
    seen: list[dict[str, float | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(timeouts_of(request))
        return ok()

    upstream = timed(handler, clock)

    with deadline_scope(2.0, clock=clock):
        upstream.get_json(URL)
    upstream.get_json(URL)

    assert seen[0] == {"connect": 2.0, "read": 2.0, "write": 2.0, "pool": 2.0}
    assert seen[1] == {"connect": 3.0, "read": 8.0, "write": 8.0, "pool": 3.0}


def test_an_attempt_is_bounded_even_without_a_request_deadline() -> None:
    clock = Clock()
    seen: list[dict[str, float | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(timeouts_of(request))
        return ok()

    upstream = timed(handler, clock, policy=HttpPolicy(attempt_deadline_s=1.5))

    upstream.get_json(URL)

    assert seen == [{"connect": 1.5, "read": 1.5, "write": 1.5, "pool": 1.5}]


def test_a_request_with_no_time_left_is_not_sent() -> None:
    clock = Clock()
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return ok()

    upstream = timed(handler, clock)

    with deadline_scope(5.0, clock=clock):
        clock.now += 4.9  # 0.1 s left: less than any upstream can answer in
        with pytest.raises(DeadlineExceededError) as raised:
            upstream.get_json(URL)

    assert sent == []
    assert isinstance(raised.value, ProviderUnavailableError)
    assert raised.value.provider == NAME


def test_no_retry_is_started_when_waiting_for_it_would_cross_the_deadline() -> None:
    clock = Clock()
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(503, headers={"Retry-After": "4"})

    upstream = timed(handler, clock)

    with deadline_scope(4.0, clock=clock), pytest.raises(ProviderUnavailableError) as raised:
        upstream.get_json(URL)

    assert (len(sent), clock.now) == (1, 1_000.0)  # it neither slept nor tried again
    assert raised.value.message == "HTTP 503"


def test_a_retry_that_fits_inside_the_deadline_still_happens() -> None:
    clock = Clock()
    answers = iter([httpx.Response(503, headers={"Retry-After": "2"}), ok()])
    upstream = timed(lambda _request: next(answers), clock)

    with deadline_scope(10.0, clock=clock):
        assert upstream.get_json(URL) == DOCUMENT

    assert clock.now == 1_002.0


def test_a_rate_limit_retry_is_not_started_when_it_would_cross_the_deadline() -> None:
    clock = Clock()
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(429, headers={"Retry-After": "3"})

    upstream = timed(handler, clock)

    with deadline_scope(3.0, clock=clock), pytest.raises(ProviderRateLimitedError):
        upstream.get_json(URL)

    assert len(sent) == 1


def test_a_transport_failure_is_not_retried_when_the_backoff_would_cross_the_deadline() -> None:
    clock = Clock()
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        raise httpx.ConnectError("refused")

    upstream = timed(handler, clock)

    with deadline_scope(0.35, clock=clock), pytest.raises(ProviderUnavailableError) as raised:
        upstream.get_json(URL)

    assert len(sent) == 1
    assert raised.value.message == "connection failed"


def test_a_body_that_keeps_arriving_is_cut_off_at_the_deadline() -> None:
    clock = Clock()

    class SlowDrip(httpx.SyncByteStream):
        def __iter__(self) -> Iterator[bytes]:
            for _ in range(100):
                clock.now += 1.0  # each chunk arrives within httpx's per-read timeout
                yield b" "

    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, stream=SlowDrip())

    upstream = timed(handler, clock)

    with deadline_scope(3.0, clock=clock), pytest.raises(ProviderUnavailableError) as raised:
        upstream.get_json(URL)

    assert raised.value.message == "timed out"
    assert len(sent) == 1  # the deadline is gone: no second attempt
    assert 1_003.0 <= clock.now <= 1_004.0  # stopped at the limit, not after all 100 chunks


# --------------------------------------------------------------------------- the attempt hook


def test_the_hook_runs_before_every_attempt_with_the_cost_of_the_request() -> None:
    clock = Clock()
    log: list[str] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        log.append("send")
        return httpx.Response(503) if log.count("send") < 3 else ok()

    upstream = timed(handler, clock, before_attempt=lambda cost: log.append(f"hook {cost}"))

    result = upstream.request_json(JsonRequest("GET", URL, idempotent=True, cost=7))

    assert result == DOCUMENT
    assert log == ["hook 7", "send", "hook 7", "send", "hook 7", "send"]


def test_a_hook_that_refuses_stops_the_request_before_it_is_sent() -> None:
    clock = Clock()
    sent: list[httpx.Request] = []

    def refuse(_cost: int) -> None:
        raise UpstreamBudgetExhaustedError(NAME, "budget exhausted", retry_after_s=12.0)

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return ok()

    upstream = timed(handler, clock, before_attempt=refuse)

    with pytest.raises(UpstreamBudgetExhaustedError) as raised:
        upstream.get_json(URL)

    assert sent == []
    assert isinstance(raised.value, ProviderRateLimitedError)
    assert raised.value.retry_after_s == 12.0


def test_no_hook_charge_is_made_for_a_request_that_cannot_be_sent() -> None:
    clock = Clock()
    charged: list[int] = []
    upstream = timed(lambda _request: ok(), clock, before_attempt=charged.append)

    with deadline_scope(5.0, clock=clock):
        clock.now += 4.9
        with pytest.raises(DeadlineExceededError):
            upstream.get_json(URL)

    assert charged == []


def test_time_spent_in_the_hook_is_taken_from_the_attempt() -> None:
    clock = Clock()
    seen: list[dict[str, float | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(timeouts_of(request))
        return ok()

    upstream = timed(handler, clock, before_attempt=lambda _cost: clock.sleep(1.0))

    with deadline_scope(2.5, clock=clock):
        upstream.get_json(URL)

    assert seen[0]["read"] == 1.5  # 2.5 s of budget, one second of it spent waiting in the hook
