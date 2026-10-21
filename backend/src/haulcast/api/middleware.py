"""Request-level middleware: request identity, host/origin/content guards, headers and access log.

Order matters (see ``MIDDLEWARE`` in the settings): :class:`RequestContextMiddleware` is
outermost, so *every* response (including errors produced by inner layers) gets the request id,
the security headers and a ``problem+json`` body if it is an error;
:class:`RequestGuardMiddleware` rejects bad unsafe requests before any work (or database access).
"""

import logging
import re
import time
import uuid
from collections.abc import Callable
from typing import Final
from urllib.parse import urlsplit

from django.conf import settings
from django.core.exceptions import DisallowedHost
from django.http import HttpRequest, HttpResponse

from haulcast.api.errors import (
    is_problem,
    normalize_error_response,
    payload_too_large,
    render_problem,
)
from haulcast.observability import (
    UpstreamCall,
    begin_request_metrics,
    end_request_metrics,
    reset_request_id,
    set_request_id,
)
from haulcast.problems import ProblemError

logger = logging.getLogger("haulcast.api.access")

REQUEST_ID_HEADER: Final = "X-Request-ID"
PUBLIC_CORS_PATHS: Final = frozenset({"/api/v1/rules", "/api/v1/openapi.json"})
"""The only endpoints that answer cross-origin reads (``Access-Control-Allow-Origin: *``)."""

_REQUEST_ID_PATTERN: Final = re.compile(r"[A-Za-z0-9-]{8,64}")
_SAFE_METHODS: Final = frozenset({"GET", "HEAD", "OPTIONS"})
_READ_METHODS: Final = frozenset({"GET", "HEAD"})
"""Methods whose responses may be cached; HEAD must describe exactly what GET would."""
_JSON_MEDIA_TYPE: Final = "application/json"
_HTTP_ERROR_FIRST: Final = 400

GetResponse = Callable[[HttpRequest], HttpResponse]


def accept_or_generate_request_id(inbound: str | None) -> str:
    """Return ``inbound`` if it matches ``^[A-Za-z0-9-]{8,64}$``, else a fresh UUID4."""
    if inbound is not None and _REQUEST_ID_PATTERN.fullmatch(inbound) is not None:
        return inbound
    return str(uuid.uuid4())


def _cache_summary(outcomes: tuple[str, ...]) -> str:
    """Collapse the per-lookup cache outcomes of a request into ``none|hit|miss|mixed``."""
    distinct = set(outcomes)
    if not distinct:
        return "none"
    return distinct.pop() if len(distinct) == 1 else "mixed"


class RequestContextMiddleware:
    """Outermost layer: request id, host validation, response hardening and the access log."""

    def __init__(self, get_response: GetResponse) -> None:
        """Wrap the next layer of the middleware chain."""
        self._get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        """Serve ``request`` and return the response with headers, problem body and log applied."""
        request_id = accept_or_generate_request_id(request.headers.get(REQUEST_ID_HEADER))
        id_token = set_request_id(request_id)
        metrics_tokens = begin_request_metrics()
        started = time.perf_counter()
        try:
            try:
                response = self._serve(request)
                response = self._harden(request, response, request_id)
            finally:
                upstream, cache = end_request_metrics(metrics_tokens)
            # Written while the id is still bound: ``JsonFormatter`` stamps the id of the context
            # a record is emitted in, so a line written after the reset would carry ``-``.
            self._log_access(request, response, started, upstream, cache)
        finally:
            reset_request_id(id_token)
        return response

    @staticmethod
    def _log_access(
        request: HttpRequest,
        response: HttpResponse,
        started: float,
        upstream: tuple[UpstreamCall, ...],
        cache: tuple[str, ...],
    ) -> None:
        """Write the access-log line: path (never the query string), status, timings, cache."""
        logger.info(
            "request",
            extra={
                "event": "request",
                "method": request.method,
                "path": request.path,
                "status": response.status_code,
                "latency_ms": round((time.perf_counter() - started) * 1000.0, 1),
                "cache": _cache_summary(cache),
                "upstream": [
                    {
                        "provider": call.provider,
                        "outcome": call.outcome,
                        "ms": round(call.elapsed_ms, 1),
                    }
                    for call in upstream
                ],
            },
        )

    def _serve(self, request: HttpRequest) -> HttpResponse:
        """Validate the Host header (``ALLOWED_HOSTS``) and delegate to the inner layers.

        HEAD is answered as GET with the body removed (RFC 9110, 9.3.2): Ninja routes only the
        methods an operation declares, and ``curl -I`` is how deployments are smoke-tested.
        """
        try:
            request.get_host()
        except DisallowedHost:
            return render_problem(ProblemError("bad_request", detail="Invalid Host header."))
        if request.method != "HEAD":
            return self._get_response(request)
        request.method = "GET"
        try:
            response = self._get_response(request)
        finally:
            request.method = "HEAD"
        length = len(response.content)
        response.content = b""
        response["Content-Length"] = str(length)
        return response

    @staticmethod
    def _harden(request: HttpRequest, response: HttpResponse, request_id: str) -> HttpResponse:
        """Apply the API's response headers; rewrite error bodies that are not ``problem+json``."""
        if response.status_code >= _HTTP_ERROR_FIRST and not is_problem(response):
            response = normalize_error_response(response)
        response[REQUEST_ID_HEADER] = request_id
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", settings.SECURE_REFERRER_POLICY)
        public = request.method in _READ_METHODS and request.path in PUBLIC_CORS_PATHS
        response["Cross-Origin-Resource-Policy"] = "cross-origin" if public else "same-origin"
        if public:
            response["Access-Control-Allow-Origin"] = "*"
        if request.method not in _READ_METHODS or response.status_code >= _HTTP_ERROR_FIRST:
            response["Cache-Control"] = "no-store"
        response.headers.setdefault("Cache-Control", "no-store")
        return response


def _normalized_origin(origin: str) -> str:
    """Lower-case ``origin`` and drop a trailing slash, for comparison with the allow-list."""
    return origin.rstrip("/").lower()


def _origin_allowed(request: HttpRequest) -> bool:
    """Return whether the request's ``Origin`` header (if any) may POST to this API.

    Browsers always send ``Origin`` on cross-origin POSTs, so a present header must name this very
    host or an explicitly allowed origin; requests without one come from non-browser clients, which
    cannot be tricked into sending a victim's credentials (there are none: the API is cookie-free).
    """
    origin = request.headers.get("Origin")
    if origin is None:
        return True
    parts = urlsplit(origin)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        return False
    if parts.netloc.lower() == request.get_host().lower():
        return True
    return _normalized_origin(origin) in settings.HAULCAST_ALLOWED_ORIGINS


class RequestGuardMiddleware:
    """Reject unsafe requests with an oversized body, a foreign origin or a non-JSON type."""

    def __init__(self, get_response: GetResponse) -> None:
        """Wrap the next layer of the middleware chain."""
        self._get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        """Return a ``problem+json`` rejection, or delegate to the inner layers."""
        if request.method not in _SAFE_METHODS:
            error = self._rejection(request)
            if error is not None:
                return render_problem(error)
        return self._get_response(request)

    @staticmethod
    def _rejection(request: HttpRequest) -> ProblemError | None:
        """Check body size (413), origin (403) and content type (400), in that order."""
        declared = request.META.get("CONTENT_LENGTH", "")
        if declared.isdecimal() and int(declared) > settings.DATA_UPLOAD_MAX_MEMORY_SIZE:
            return payload_too_large()
        if not _origin_allowed(request):
            return ProblemError(
                "origin_not_allowed", detail="Cross-origin requests are not allowed."
            )
        if request.content_type != _JSON_MEDIA_TYPE:
            return ProblemError("invalid_content_type", detail="Send the body as application/json.")
        return None
