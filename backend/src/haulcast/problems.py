"""The API's error vocabulary: stable machine-readable problem codes and their HTTP semantics.

Services and endpoints raise :class:`ProblemError`; the API layer renders it as an RFC 9457
``application/problem+json`` document (see :mod:`haulcast.api.errors`). Keeping the catalogue
free of Django lets every layer share one taxonomy, and keeps the ``code`` values (which clients
branch on) in a single reviewed place.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Final

PROBLEM_DOCS_URL: Final = (
    "https://github.com/ar27111994/weather-aware-truck-routing/blob/main/docs/api/problems.md"
)
"""Base of every problem ``type`` URI; the fragment is the problem's :attr:`ProblemSpec.anchor`."""

PROBLEM_MEDIA_TYPE: Final = "application/problem+json"


class ProblemCode(StrEnum):
    """The stable machine-readable ``code`` of every problem the API answers with.

    The members are the wire values: clients branch on them, and the OpenAPI document publishes the
    members as the enum of ``ProblemSchema.code`` (D-24), so a new problem starts here and a typo
    in a code is a type error instead of a ``KeyError`` on the day it is raised.
    """

    BAD_REQUEST = "bad_request"
    MALFORMED_JSON = "malformed_json"
    INVALID_CONTENT_TYPE = "invalid_content_type"
    UNAUTHORIZED = "unauthorized"
    FORBIDDEN = "forbidden"
    ORIGIN_NOT_ALLOWED = "origin_not_allowed"
    NOT_FOUND = "not_found"
    PLAN_NOT_FOUND = "plan_not_found"
    METHOD_NOT_ALLOWED = "method_not_allowed"
    PAYLOAD_TOO_LARGE = "payload_too_large"
    VALIDATION_ERROR = "validation_error"
    NO_ROUTE_FOUND = "no_route_found"
    SAME_ORIGIN_DESTINATION = "same_origin_destination"
    ROUTE_TOO_LONG = "route_too_long"
    TOO_MANY_CHECKPOINTS = "too_many_checkpoints"
    DEPARTURE_OUT_OF_RANGE = "departure_out_of_range"
    RATE_LIMITED = "rate_limited"
    INTERNAL_ERROR = "internal_error"
    BAD_GATEWAY = "bad_gateway"
    SERVICE_UNAVAILABLE = "service_unavailable"
    ROUTING_UNAVAILABLE = "routing_unavailable"
    WEATHER_UNAVAILABLE = "weather_unavailable"
    WEATHER_CAPACITY_EXHAUSTED = "weather_capacity_exhausted"
    GEOCODING_UNAVAILABLE = "geocoding_unavailable"
    DATABASE_UNAVAILABLE = "database_unavailable"


@dataclass(frozen=True, slots=True)
class ProblemSpec:
    """HTTP semantics of one problem code."""

    status: int
    title: str
    anchor: str


def _spec(status: int, title: str, anchor: str) -> ProblemSpec:
    return ProblemSpec(status=status, title=title, anchor=anchor)


PROBLEMS: Final[Mapping[ProblemCode, ProblemSpec]] = {
    ProblemCode.BAD_REQUEST: _spec(400, "Bad request", "bad-request"),
    ProblemCode.MALFORMED_JSON: _spec(400, "Malformed JSON", "malformed-json"),
    ProblemCode.INVALID_CONTENT_TYPE: _spec(
        400, "Unsupported content type", "invalid-content-type"
    ),
    ProblemCode.UNAUTHORIZED: _spec(401, "Unauthorized", "unauthorized"),
    ProblemCode.FORBIDDEN: _spec(403, "Forbidden", "forbidden"),
    ProblemCode.ORIGIN_NOT_ALLOWED: _spec(403, "Origin not allowed", "origin-not-allowed"),
    ProblemCode.NOT_FOUND: _spec(404, "Not found", "not-found"),
    ProblemCode.PLAN_NOT_FOUND: _spec(404, "Plan not found", "plan-not-found"),
    ProblemCode.METHOD_NOT_ALLOWED: _spec(405, "Method not allowed", "method-not-allowed"),
    ProblemCode.PAYLOAD_TOO_LARGE: _spec(413, "Request body too large", "payload-too-large"),
    ProblemCode.VALIDATION_ERROR: _spec(422, "Invalid request", "validation"),
    ProblemCode.NO_ROUTE_FOUND: _spec(422, "No route found", "no-route-found"),
    ProblemCode.SAME_ORIGIN_DESTINATION: _spec(
        422, "Origin and destination are too close", "same-origin-destination"
    ),
    ProblemCode.ROUTE_TOO_LONG: _spec(422, "Route too long", "route-too-long"),
    ProblemCode.TOO_MANY_CHECKPOINTS: _spec(422, "Too many checkpoints", "too-many-checkpoints"),
    ProblemCode.DEPARTURE_OUT_OF_RANGE: _spec(
        422, "Departure time out of range", "departure-out-of-range"
    ),
    ProblemCode.RATE_LIMITED: _spec(429, "Too many requests", "rate-limited"),
    ProblemCode.INTERNAL_ERROR: _spec(500, "Internal server error", "internal-error"),
    ProblemCode.BAD_GATEWAY: _spec(502, "Bad gateway", "bad-gateway"),
    ProblemCode.SERVICE_UNAVAILABLE: _spec(503, "Service unavailable", "service-unavailable"),
    ProblemCode.ROUTING_UNAVAILABLE: _spec(503, "Routing is unavailable", "routing-unavailable"),
    ProblemCode.WEATHER_UNAVAILABLE: _spec(503, "Weather is unavailable", "weather-unavailable"),
    ProblemCode.WEATHER_CAPACITY_EXHAUSTED: _spec(
        503, "Weather capacity exhausted", "weather-capacity-exhausted"
    ),
    ProblemCode.GEOCODING_UNAVAILABLE: _spec(
        503, "Geocoding is unavailable", "geocoding-unavailable"
    ),
    ProblemCode.DATABASE_UNAVAILABLE: _spec(503, "Database is unavailable", "database-unavailable"),
}
"""Every problem the API can answer with, keyed by its stable ``code``."""

FALLBACK_BY_STATUS: Final[Mapping[int, ProblemCode]] = {
    400: ProblemCode.BAD_REQUEST,
    401: ProblemCode.UNAUTHORIZED,
    403: ProblemCode.FORBIDDEN,
    404: ProblemCode.NOT_FOUND,
    405: ProblemCode.METHOD_NOT_ALLOWED,
    413: ProblemCode.PAYLOAD_TOO_LARGE,
    422: ProblemCode.VALIDATION_ERROR,
    429: ProblemCode.RATE_LIMITED,
    502: ProblemCode.BAD_GATEWAY,
    503: ProblemCode.SERVICE_UNAVAILABLE,
}
"""Code used when a non-problem error response must be rewritten and only its status is known.

The 502/503 entries are deliberately generic (not ``routing_unavailable`` or similar): a bare 502
or 503 says nothing about *which* dependency failed, and the status must survive the rewrite.
"""

DEFAULT_ERROR_CODE: Final = ProblemCode.INTERNAL_ERROR


@dataclass(frozen=True, slots=True)
class FieldError:
    """One entry of a validation problem's ``errors`` array (location, message, kind)."""

    loc: tuple[str | int, ...]
    msg: str
    type: str


class ProblemError(Exception):
    """An error the API reports as ``problem+json``; ``code`` selects its catalogue entry.

    ``status`` overrides the catalogue's default (for example 502 instead of 503 when an upstream
    answered garbage); ``retry_after_s`` becomes a ``Retry-After`` header.
    """

    def __init__(
        self,
        code: ProblemCode,
        *,
        detail: str | None = None,
        status: int | None = None,
        errors: Sequence[FieldError] = (),
        retry_after_s: float | None = None,
    ) -> None:
        """Build the problem ``code`` stands for."""
        spec = PROBLEMS[code]
        super().__init__(f"{code}: {detail}" if detail else str(code))
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
    code: ProblemCode
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
