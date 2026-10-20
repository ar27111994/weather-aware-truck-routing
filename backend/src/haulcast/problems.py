"""The API's error vocabulary: stable machine-readable problem codes and their HTTP semantics.

Services and endpoints raise :class:`ProblemError`; the API layer renders it as an RFC 9457
``application/problem+json`` document (see :mod:`haulcast.api.errors`). Keeping the catalogue
free of Django lets every layer share one taxonomy, and keeps the ``code`` values (which clients
branch on) in a single reviewed place.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Final

PROBLEM_DOCS_URL: Final = (
    "https://github.com/ar27111994/weather-aware-truck-routing/blob/main/docs/api/problems.md"
)
"""Base of every problem ``type`` URI; the fragment is the problem's :attr:`ProblemSpec.anchor`."""

PROBLEM_MEDIA_TYPE: Final = "application/problem+json"


@dataclass(frozen=True, slots=True)
class ProblemSpec:
    """HTTP semantics of one problem code."""

    status: int
    title: str
    anchor: str


def _spec(status: int, title: str, anchor: str) -> ProblemSpec:
    return ProblemSpec(status=status, title=title, anchor=anchor)


PROBLEMS: Final[Mapping[str, ProblemSpec]] = {
    "bad_request": _spec(400, "Bad request", "bad-request"),
    "malformed_json": _spec(400, "Malformed JSON", "malformed-json"),
    "invalid_content_type": _spec(400, "Unsupported content type", "invalid-content-type"),
    "unauthorized": _spec(401, "Unauthorized", "unauthorized"),
    "forbidden": _spec(403, "Forbidden", "forbidden"),
    "origin_not_allowed": _spec(403, "Origin not allowed", "origin-not-allowed"),
    "not_found": _spec(404, "Not found", "not-found"),
    "plan_not_found": _spec(404, "Plan not found", "plan-not-found"),
    "method_not_allowed": _spec(405, "Method not allowed", "method-not-allowed"),
    "payload_too_large": _spec(413, "Request body too large", "payload-too-large"),
    "validation_error": _spec(422, "Invalid request", "validation"),
    "no_route_found": _spec(422, "No route found", "no-route-found"),
    "same_origin_destination": _spec(
        422, "Origin and destination are too close", "same-origin-destination"
    ),
    "route_too_long": _spec(422, "Route too long", "route-too-long"),
    "too_many_checkpoints": _spec(422, "Too many checkpoints", "too-many-checkpoints"),
    "departure_out_of_range": _spec(422, "Departure time out of range", "departure-out-of-range"),
    "rate_limited": _spec(429, "Too many requests", "rate-limited"),
    "internal_error": _spec(500, "Internal server error", "internal-error"),
    "bad_gateway": _spec(502, "Bad gateway", "bad-gateway"),
    "service_unavailable": _spec(503, "Service unavailable", "service-unavailable"),
    "routing_unavailable": _spec(503, "Routing is unavailable", "routing-unavailable"),
    "weather_unavailable": _spec(503, "Weather is unavailable", "weather-unavailable"),
    "weather_capacity_exhausted": _spec(
        503, "Weather capacity exhausted", "weather-capacity-exhausted"
    ),
    "geocoding_unavailable": _spec(503, "Geocoding is unavailable", "geocoding-unavailable"),
    "database_unavailable": _spec(503, "Database is unavailable", "database-unavailable"),
}
"""Every problem the API can answer with, keyed by its stable ``code``."""

FALLBACK_BY_STATUS: Final[Mapping[int, str]] = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    413: "payload_too_large",
    422: "validation_error",
    429: "rate_limited",
    502: "bad_gateway",
    503: "service_unavailable",
}
"""Code used when a non-problem error response must be rewritten and only its status is known.

The 502/503 entries are deliberately generic (not ``routing_unavailable`` or similar): a bare 502
or 503 says nothing about *which* dependency failed, and the status must survive the rewrite.
"""

DEFAULT_ERROR_CODE: Final = "internal_error"


@dataclass(frozen=True, slots=True)
class FieldError:
    """One entry of a validation problem's ``errors`` array (location, message, kind)."""

    loc: tuple[str | int, ...]
    msg: str
    type: str


class ProblemError(Exception):
    """An error the API reports as ``problem+json``; ``code`` must be a key of :data:`PROBLEMS`.

    ``status`` overrides the catalogue's default (for example 502 instead of 503 when an upstream
    answered garbage); ``retry_after_s`` becomes a ``Retry-After`` header.
    """

    def __init__(
        self,
        code: str,
        *,
        detail: str | None = None,
        status: int | None = None,
        errors: Sequence[FieldError] = (),
        retry_after_s: float | None = None,
    ) -> None:
        """Build a problem for ``code``; unknown codes are a programming error."""
        spec = PROBLEMS[code]
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.spec = spec
        self.status = spec.status if status is None else status
        self.detail = detail
        self.errors: tuple[FieldError, ...] = tuple(errors)
        self.retry_after_s = retry_after_s


@dataclass(frozen=True, slots=True)
class ProblemDocument:
    """The JSON body of a problem response (before serialisation)."""

    type: str
    title: str
    status: int
    code: str
    request_id: str
    detail: str | None = None
    errors: tuple[FieldError, ...] = field(default=())

    def to_json_object(self) -> dict[str, object]:
        """Return the body as a plain JSON-serialisable dict (``detail``/``errors`` only if set)."""
        body: dict[str, object] = {
            "type": self.type,
            "title": self.title,
            "status": self.status,
        }
        if self.detail is not None:
            body["detail"] = self.detail
        body["code"] = self.code
        if self.errors:
            body["errors"] = [
                {"loc": list(error.loc), "msg": error.msg, "type": error.type}
                for error in self.errors
            ]
        body["request_id"] = self.request_id
        return body


def document_for(error: ProblemError, request_id: str) -> ProblemDocument:
    """Build the :class:`ProblemDocument` describing ``error`` for the request ``request_id``."""
    return ProblemDocument(
        type=f"{PROBLEM_DOCS_URL}#{error.spec.anchor}",
        title=error.spec.title,
        status=error.status,
        code=error.code,
        request_id=request_id,
        detail=error.detail,
        errors=error.errors,
    )
