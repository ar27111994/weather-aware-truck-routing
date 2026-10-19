"""Shared outbound HTTP plumbing for the provider adapters.

One place decides the timeouts, the identification headers, the retry policy and how HTTP failures
map onto :mod:`haulcast.providers.errors`, so every adapter behaves the same way and only
contains the protocol knowledge of its own upstream.

Policy (API contract, "Timeouts"): connect 3 s, read 8 s, two retries with full-jitter exponential
backoff for idempotent calls, one retry after an HTTP 429 that asks for a short wait. Redirects
are never followed and responses are size-capped, so a compromised or misbehaving upstream cannot
steer the request elsewhere or exhaust memory. Adapters build URLs from constants only: no
user-supplied value ever becomes a host, scheme or path (SSRF-proof by construction).
"""

import json
import math
import random
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Final

import httpx

from haulcast import __version__
from haulcast.observability import record_upstream_call
from haulcast.providers.errors import (
    ProviderRateLimitedError,
    ProviderRejectedError,
    ProviderResponseError,
    ProviderUnavailableError,
)

REPOSITORY_URL: Final = "https://github.com/ar27111994/weather-aware-truck-routing"
USER_AGENT: Final = f"Haulcast/{__version__} (+{REPOSITORY_URL})"
"""Identifies this application to every upstream, as their fair-use policies ask."""

_HTTP_OK_FIRST: Final = 200
_HTTP_OK_LAST: Final = 299
_HTTP_TOO_MANY_REQUESTS: Final = 429
_HTTP_CLIENT_ERROR_FIRST: Final = 400
_HTTP_SERVER_ERROR_FIRST: Final = 500
_DETAIL_MAX_CHARS: Final = 160
_MAX_CONNECTIONS: Final = 10
_MAX_KEEPALIVE_CONNECTIONS: Final = 5

QueryParams = Mapping[str, str | int | float]
"""Query-string parameters accepted by :class:`UpstreamClient` (values are stringified by httpx)."""


@dataclass(frozen=True, slots=True)
class HttpPolicy:
    """Timeouts and retry behaviour for one upstream."""

    connect_timeout_s: float = 3.0
    read_timeout_s: float = 8.0
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
class JsonRequest:
    """One outbound request whose response is a JSON document."""

    method: str
    url: str
    params: QueryParams | None = None
    form: Mapping[str, str] | None = None
    json_body: object | None = None
    headers: Mapping[str, str] | None = None
    idempotent: bool = True
    """Whether repeating the request is harmless (all our upstream calls are reads)."""


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


def parse_retry_after(headers: Mapping[str, str]) -> float | None:
    """Return the ``Retry-After`` delay in seconds, or ``None`` if absent or not a plain number.

    The HTTP-date form is deliberately ignored: none of our upstreams send it, and treating an
    unparsable hint as "unknown" is safe because callers then fall back to jittered backoff.
    """
    raw = {key.lower(): value for key, value in headers.items()}.get("retry-after")
    if raw is None:
        return None
    try:
        seconds = float(raw.strip())
    except ValueError:
        return None
    if not math.isfinite(seconds) or seconds < 0:
        return None
    return seconds


def _printable(text: str) -> str:
    """Strip control characters and cap the length so upstream text is safe to log."""
    return "".join(ch for ch in text if ch.isprintable())[:_DETAIL_MAX_CHARS]


def _describe_rejection(body: bytes) -> tuple[str | None, str]:
    """Extract ``(machine code, human text)`` from an upstream 4xx body, tolerating any shape."""
    try:
        payload = json.loads(body)
    except ValueError:
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
    """An :class:`httpx.Client` plus the retry policy, sleep and jitter source for one upstream.

    ``sleep`` and ``random_fn`` are injectable so tests run instantly and deterministically.
    """

    def __init__(
        self,
        provider: str,
        *,
        client: httpx.Client,
        policy: HttpPolicy = DEFAULT_POLICY,
        sleep: Callable[[float], None] = time.sleep,
        random_fn: Callable[[], float] = random.random,
    ) -> None:
        """Bind the upstream ``provider`` name, its ``client`` and retry/jitter behaviour."""
        self.provider = provider
        self.policy = policy
        self._client = client
        self._sleep = sleep
        self._random = random_fn

    def get_json(
        self,
        url: str,
        *,
        params: QueryParams | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> object:
        """GET ``url`` and return the decoded JSON document."""
        return self.request_json(JsonRequest("GET", url, params=params, headers=headers))

    def post_json(
        self,
        url: str,
        *,
        body: object,
        headers: Mapping[str, str] | None = None,
    ) -> object:
        """POST ``body`` as JSON and return the decoded JSON document."""
        return self.request_json(JsonRequest("POST", url, json_body=body, headers=headers))

    def post_form(
        self,
        url: str,
        *,
        form: Mapping[str, str],
        headers: Mapping[str, str] | None = None,
    ) -> object:
        """POST ``form`` as ``application/x-www-form-urlencoded`` and return the decoded JSON."""
        return self.request_json(JsonRequest("POST", url, form=form, headers=headers))

    def request_json(self, request: JsonRequest) -> object:
        """Send ``request``, retrying per the policy, and return the decoded JSON document.

        Raises:
            ProviderUnavailableError: timeout, connection failure or 5xx after the retry budget.
            ProviderRateLimitedError: HTTP 429 after the retry budget (or a wait we may not take).
            ProviderRejectedError: any other 4xx.
            ProviderResponseError: 2xx/3xx with a body that is empty, oversized or not JSON.
        """
        transient_retries = 0
        rate_limit_retries = 0
        while True:
            started = time.perf_counter()
            try:
                status, headers, body = self._send(request)
            except httpx.TransportError as exc:
                outcome = "timeout" if isinstance(exc, httpx.TimeoutException) else "network_error"
                self._record(outcome, started)
                if request.idempotent and transient_retries < self.policy.max_retries:
                    self._sleep(self._backoff(transient_retries))
                    transient_retries += 1
                    continue
                reason = "timed out" if outcome == "timeout" else "connection failed"
                raise ProviderUnavailableError(self.provider, reason) from exc
            self._record(f"http_{status}", started)
            retry_after = parse_retry_after(headers)
            if status == _HTTP_TOO_MANY_REQUESTS:
                wait = self._wait_for(rate_limit_retries, retry_after)
                if (
                    request.idempotent
                    and rate_limit_retries < self.policy.rate_limit_retries
                    and wait is not None
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

    def _send(self, request: JsonRequest) -> tuple[int, httpx.Headers, bytes]:
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
            ) as response:
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > limit:
                        raise ProviderResponseError(
                            self.provider, f"response larger than {limit} bytes"
                        )
                return response.status_code, response.headers, bytes(body)
        except httpx.DecodingError as exc:
            raise ProviderResponseError(self.provider, "undecodable response body") from exc

    def _decode(self, status: int, body: bytes) -> object:
        """Return the JSON document of a successful response, else raise ProviderResponseError."""
        if not _HTTP_OK_FIRST <= status <= _HTTP_OK_LAST:
            raise ProviderResponseError(self.provider, f"unexpected HTTP {status}")
        try:
            return json.loads(body)
        except ValueError as exc:  # JSONDecodeError and UnicodeDecodeError, including an empty body
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
