"""Shared outbound HTTP plumbing for the provider adapters.

One place decides the timeouts, the identification headers, the retry policy and how HTTP failures
map onto :mod:`haulcast.providers.errors`, so every adapter behaves the same way and only
contains the protocol knowledge of its own upstream.

Policy (API contract, "Timeouts"): connect 3 s, read 8 s, two retries with full-jitter exponential
backoff for idempotent calls, one retry after an HTTP 429 that *names* a short wait (a 429 without
a hint says nothing about when to come back, so it surfaces). Redirects are never followed and
responses are size-capped, so a compromised or misbehaving upstream cannot steer the request
elsewhere or exhaust memory. Adapters build every URL from constants and validated numbers: no
user-supplied text ever becomes a host, a scheme or a path segment (SSRF-proof by construction).

Time is bounded as a whole, not only per phase. httpx times each connect, each *chunk* read and each
write separately, so connect 3 s, read 8 s and two retries could keep one call alive for 25 s, and
a body that drips one byte at a time forever. Every attempt is therefore cut to what the request's
:mod:`~haulcast.providers.deadline` has left (and to ``attempt_deadline_s`` when there is none),
including the time its body takes to arrive, and no retry or sleep starts that would cross the end.

Adapters that share an allowance with other callers, or must keep a minimum interval between calls
to a fair-use server, pass ``before_attempt``: it runs before *every* attempt, retries included,
which a check made once per logical call could not do.
"""

import json
import random
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Final

import httpx

from haulcast import __version__
from haulcast.observability import record_upstream_call
from haulcast.providers.deadline import MIN_ATTEMPT_S, Deadline, current_deadline
from haulcast.providers.errors import (
    DeadlineExceededError,
    ProviderRateLimitedError,
    ProviderRejectedError,
    ProviderResponseError,
    ProviderUnavailableError,
)

REPOSITORY_URL: Final = "https://github.com/ar27111994/weather-aware-truck-routing"
USER_AGENT: Final = f"Haulcast/{__version__} (+{REPOSITORY_URL})"
"""Identifies this application to every upstream, as their fair-use policies ask."""

MAX_RETRY_AFTER_S: Final = 3_600.0
"""Longest ``Retry-After`` hint passed on to callers (and so to clients): an hour."""

_HTTP_OK_FIRST: Final = 200
_HTTP_OK_LAST: Final = 299
_HTTP_TOO_MANY_REQUESTS: Final = 429
_HTTP_CLIENT_ERROR_FIRST: Final = 400
_HTTP_SERVER_ERROR_FIRST: Final = 500
_DETAIL_MAX_CHARS: Final = 160
_MAX_CONNECTIONS: Final = 10
_MAX_KEEPALIVE_CONNECTIONS: Final = 5
_DELAY_SECONDS: Final = re.compile(r"[0-9]{1,12}")

QueryParams = Mapping[str, str | int | float]
"""Query-string parameters accepted by :class:`UpstreamClient` (values are stringified by httpx)."""


@dataclass(frozen=True, slots=True)
class HttpPolicy:
    """Timeouts and retry behaviour for one upstream."""

    connect_timeout_s: float = 3.0
    read_timeout_s: float = 8.0
    attempt_deadline_s: float = 10.0
    """Hard limit of one attempt from its start to its last body byte (httpx limits only phases)."""
    max_retries: int = 2
    """Retries after the first attempt for timeouts, connection errors and HTTP 5xx."""
    rate_limit_retries: int = 1
    """Retries after an HTTP 429 (only when the requested wait is at most ``max_wait_s``)."""
    max_wait_s: float = 5.0
    """Never sleep longer than this between attempts: a longer ``Retry-After`` surfaces instead."""
    backoff_base_s: float = 0.25
    backoff_cap_s: float = 2.0
    max_response_bytes: int = 8_000_000
    """Decoded body size above which the response is refused."""


DEFAULT_POLICY: Final = HttpPolicy()


@dataclass(frozen=True, slots=True)
class Pacing:
    """The sources of time and chance behind the retry loop, injectable so tests run instantly.

    ``sleep`` waits between attempts, ``jitter`` supplies a number in ``[0, 1)`` for the backoff
    and ``clock`` is the monotonic clock that ends an attempt whose body is still arriving.
    """

    sleep: Callable[[float], None] = time.sleep
    jitter: Callable[[], float] = random.random
    clock: Callable[[], float] = time.monotonic


DEFAULT_PACING: Final = Pacing()


@dataclass(frozen=True, slots=True)
class JsonRequest:
    """One outbound request whose response is a JSON document."""

    method: str
    url: str
    params: QueryParams | None = None
    form: Mapping[str, str] | None = None
    json_body: object | None = None
    headers: Mapping[str, str] | None = None
    idempotent: bool = False
    """Whether repeating the request is harmless. Off unless the caller says so: a request that
    writes must never be sent twice because somebody forgot to opt out."""
    cost: int = 1
    """Units of the upstream's allowance one attempt consumes (a batch of locations costs one
    unit per location); handed to the client's ``before_attempt`` hook."""


def build_client(
    *,
    headers: Mapping[str, str] | None = None,
    policy: HttpPolicy = DEFAULT_POLICY,
    transport: httpx.BaseTransport | None = None,
) -> httpx.Client:
    """Create an :class:`httpx.Client` with Haulcast's identification headers and timeouts.

    ``headers`` are added on top of the defaults (for example ``X-Client-Id``). ``transport`` lets
    tests substitute a mock transport; production code leaves it unset.
    """
    merged = {"User-Agent": USER_AGENT, "Accept": "application/json"} | dict(headers or {})
    return httpx.Client(
        timeout=httpx.Timeout(
            connect=policy.connect_timeout_s,
            read=policy.read_timeout_s,
            write=policy.read_timeout_s,
            pool=policy.connect_timeout_s,
        ),
        headers=merged,
        transport=transport,
        follow_redirects=False,
        limits=httpx.Limits(
            max_connections=_MAX_CONNECTIONS,
            max_keepalive_connections=_MAX_KEEPALIVE_CONNECTIONS,
        ),
    )


def parse_retry_after(headers: Mapping[str, str], *, now: datetime | None = None) -> float | None:
    """Return the ``Retry-After`` delay in seconds, or ``None`` if absent or not understood.

    Both forms of RFC 9110 are read: a count of whole seconds (digits only: ``float()`` would also
    accept ``1e12``, ``1_0``, ``+5`` and ``nan``) and an HTTP date, taken relative to ``now``.
    The result is clamped to an hour, because the value reaches clients as a ``Retry-After``
    header and a hostile or broken upstream could otherwise ask for a century.
    """
    raw = {key.lower(): value for key, value in headers.items()}.get("retry-after")
    if raw is None:
        return None
    text = raw.strip()
    if _DELAY_SECONDS.fullmatch(text):
        return min(float(text), MAX_RETRY_AFTER_S)
    try:
        moment = parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return None
    if moment.tzinfo is None:  # "-0000": a date whose zone nobody knows is no use as a deadline
        return None
    current = datetime.now(UTC) if now is None else now
    return min(max((moment - current).total_seconds(), 0.0), MAX_RETRY_AFTER_S)


def _printable(text: str) -> str:
    """Strip control characters and cap the length so upstream text is safe to log."""
    return "".join(ch for ch in text if ch.isprintable())[:_DETAIL_MAX_CHARS]


def _describe_rejection(body: bytes) -> tuple[str | None, str]:
    """Extract ``(machine code, human text)`` from an upstream 4xx body, tolerating any shape."""
    try:
        payload = json.loads(body)
    except (ValueError, RecursionError):
        return None, ""
    if not isinstance(payload, dict):
        return None, ""
    raw_code = payload.get("error_code", payload.get("code"))
    code = (
        str(raw_code)
        if isinstance(raw_code, int | str) and not isinstance(raw_code, bool)
        else None
    )
    text = next(
        (
            payload[key]
            for key in ("error", "message", "reason")
            if isinstance(payload.get(key), str)
        ),
        "",
    )
    return code, _printable(text)


class UpstreamClient:
    """An :class:`httpx.Client` plus the retry policy, the deadline and the attempt hook.

    ``pacing`` makes sleeping, jitter and the clock injectable. ``before_attempt(cost)`` runs
    before every attempt (see the module docs); it may block, spend a shared allowance and refuse
    by raising a ``ProviderError``.
    """

    def __init__(
        self,
        provider: str,
        *,
        client: httpx.Client,
        policy: HttpPolicy = DEFAULT_POLICY,
        pacing: Pacing = DEFAULT_PACING,
        before_attempt: Callable[[int], None] | None = None,
    ) -> None:
        """Bind the upstream ``provider`` name, its ``client`` and retry/jitter behaviour."""
        self.provider = provider
        self.policy = policy
        self._client = client
        self._sleep = pacing.sleep
        self._random = pacing.jitter
        self._clock = pacing.clock
        self._before_attempt = before_attempt

    def get_json(
        self,
        url: str,
        *,
        params: QueryParams | None = None,
        headers: Mapping[str, str] | None = None,
        cost: int = 1,
    ) -> object:
        """GET ``url`` and return the decoded JSON document (a GET is repeatable by definition)."""
        return self.request_json(
            JsonRequest("GET", url, params=params, headers=headers, idempotent=True, cost=cost)
        )

    def post_json(
        self,
        url: str,
        *,
        body: object,
        headers: Mapping[str, str] | None = None,
        idempotent: bool = False,
        cost: int = 1,
    ) -> object:
        """POST ``body`` as JSON and return the decoded JSON document.

        ``idempotent`` must be passed as ``True`` by callers whose POST is really a read (a query
        sent as a body); only then may a failed attempt be repeated.
        """
        return self.request_json(
            JsonRequest(
                "POST", url, json_body=body, headers=headers, idempotent=idempotent, cost=cost
            )
        )

    def post_form(
        self,
        url: str,
        *,
        form: Mapping[str, str],
        headers: Mapping[str, str] | None = None,
        idempotent: bool = False,
        cost: int = 1,
    ) -> object:
        """POST ``form`` as ``application/x-www-form-urlencoded`` and return the decoded JSON.

        ``idempotent`` is as for :meth:`post_json`.
        """
        return self.request_json(
            JsonRequest("POST", url, form=form, headers=headers, idempotent=idempotent, cost=cost)
        )

    def request_json(self, request: JsonRequest) -> object:
        """Send ``request``, retrying per the policy, and return the decoded JSON document.

        Raises:
            DeadlineExceededError: the request's deadline leaves too little time to ask.
            ProviderUnavailableError: timeout, connection failure or 5xx after the retry budget.
            ProviderRateLimitedError: HTTP 429 after the retry budget (or a wait we may not take).
            ProviderRejectedError: any other 4xx.
            ProviderResponseError: 2xx/3xx with a body that is empty, oversized or not JSON.
        """
        transient_retries = 0
        rate_limit_retries = 0
        deadline = current_deadline()
        while True:
            timeout, attempt_ends = self._begin_attempt(request, deadline)
            started = time.perf_counter()
            try:
                status, headers, body = self._send(request, timeout, attempt_ends)
            except httpx.TransportError as exc:
                outcome = "timeout" if isinstance(exc, httpx.TimeoutException) else "network_error"
                self._record(outcome, started)
                delay = self._backoff(transient_retries)
                if (
                    request.idempotent
                    and transient_retries < self.policy.max_retries
                    and self._fits(delay, deadline)
                ):
                    self._sleep(delay)
                    transient_retries += 1
                    continue
                reason = "timed out" if outcome == "timeout" else "connection failed"
                raise ProviderUnavailableError(self.provider, reason) from exc
            self._record(f"http_{status}", started)
            retry_after = parse_retry_after(headers)
            if status == _HTTP_TOO_MANY_REQUESTS:
                # Only an explicit, short Retry-After is worth waiting for: without one the
                # upstream has said nothing about when to come back, and asking again straight
                # away only spends another call of its allowance on a certain refusal.
                wait = (
                    retry_after
                    if retry_after is not None and retry_after <= self.policy.max_wait_s
                    else None
                )
                if (
                    request.idempotent
                    and rate_limit_retries < self.policy.rate_limit_retries
                    and wait is not None
                    and self._fits(wait, deadline)
                ):
                    self._sleep(wait)
                    rate_limit_retries += 1
                    continue
                raise ProviderRateLimitedError(
                    self.provider, "rate limited (HTTP 429)", retry_after_s=retry_after
                )
            if status >= _HTTP_SERVER_ERROR_FIRST:
                wait = self._wait_for(transient_retries, retry_after)
                if (
                    request.idempotent
                    and transient_retries < self.policy.max_retries
                    and wait is not None
                    and self._fits(wait, deadline)
                ):
                    self._sleep(wait)
                    transient_retries += 1
                    continue
                raise ProviderUnavailableError(
                    self.provider, f"HTTP {status}", retry_after_s=retry_after
                )
            if status >= _HTTP_CLIENT_ERROR_FIRST:
                code, detail = _describe_rejection(body)
                suffix = f": {detail}" if detail else ""
                raise ProviderRejectedError(
                    self.provider, f"HTTP {status}{suffix}", status=status, code=code
                )
            return self._decode(status, body)

    def _begin_attempt(
        self, request: JsonRequest, deadline: Deadline | None
    ) -> tuple[httpx.Timeout, float]:
        """Run the hook and return the attempt's timeouts and the instant its body must be done.

        Nothing is spent on an attempt that cannot be made: the time check comes first, so the
        hook (which may take tokens from a shared allowance) is only called when the call can
        follow, and again afterwards, because the hook may have waited.
        """
        self._time_left(deadline)
        if self._before_attempt is not None:
            self._before_attempt(request.cost)
        remaining = self._time_left(deadline)
        cap = (
            self.policy.attempt_deadline_s
            if remaining is None
            else min(self.policy.attempt_deadline_s, remaining)
        )
        connect = min(self.policy.connect_timeout_s, cap)
        read = min(self.policy.read_timeout_s, cap)
        return httpx.Timeout(connect=connect, read=read, write=read, pool=connect), (
            self._clock() + cap
        )

    def _time_left(self, deadline: Deadline | None) -> float | None:
        """Return the seconds the request has left (``None``: unbounded), or refuse to go on."""
        if deadline is None:
            return None
        remaining = deadline.remaining()
        if remaining < MIN_ATTEMPT_S:
            raise DeadlineExceededError(self.provider, "request deadline reached")
        return remaining

    @staticmethod
    def _fits(delay: float, deadline: Deadline | None) -> bool:
        """Whether sleeping ``delay`` still leaves time for another attempt."""
        return deadline is None or delay + MIN_ATTEMPT_S <= deadline.remaining()

    def _send(
        self, request: JsonRequest, timeout: httpx.Timeout, attempt_ends: float
    ) -> tuple[int, httpx.Headers, bytes]:
        """Perform one attempt, reading at most ``max_response_bytes`` of decoded body."""
        limit = self.policy.max_response_bytes
        try:
            with self._client.stream(
                request.method,
                request.url,
                params=request.params,
                data=request.form,
                json=request.json_body,
                headers=request.headers,
                timeout=timeout,
            ) as response:
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > limit:
                        raise ProviderResponseError(
                            self.provider, f"response larger than {limit} bytes"
                        )
                    if self._clock() >= attempt_ends:
                        raise httpx.ReadTimeout("the attempt ran out of time before its body ended")
                return response.status_code, response.headers, bytes(body)
        except httpx.DecodingError as exc:
            raise ProviderResponseError(self.provider, "undecodable response body") from exc

    def _decode(self, status: int, body: bytes) -> object:
        """Return the JSON document of a successful response, else raise ProviderResponseError."""
        if not _HTTP_OK_FIRST <= status <= _HTTP_OK_LAST:
            raise ProviderResponseError(self.provider, f"unexpected HTTP {status}")
        try:
            return json.loads(body)
        except (ValueError, RecursionError) as exc:
            # JSONDecodeError and UnicodeDecodeError (an empty or binary body), and a document
            # nested deeper than the parser's recursion limit.
            raise ProviderResponseError(self.provider, "response is not valid JSON") from exc

    def _backoff(self, attempt: int) -> float:
        """Full-jitter exponential backoff: uniform in ``[0, min(cap, base * 2**attempt)]``."""
        ceiling = min(self.policy.backoff_cap_s, self.policy.backoff_base_s * 2.0**attempt)
        return ceiling * self._random()

    def _wait_for(self, attempt: int, retry_after: float | None) -> float | None:
        """Seconds to sleep before retrying, or ``None`` if the upstream asks for too long."""
        if retry_after is None:
            return self._backoff(attempt)
        if retry_after > self.policy.max_wait_s:
            return None
        return retry_after

    def _record(self, outcome: str, started: float) -> None:
        """Report one attempt to the per-request metrics."""
        record_upstream_call(self.provider, outcome, (time.perf_counter() - started) * 1000.0)
