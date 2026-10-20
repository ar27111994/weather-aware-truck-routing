"""``GET /api/v1/geocode``: place search behind the origin and destination fields."""

from dataclasses import asdict
from typing import Annotated, Final

from django.http import HttpRequest, HttpResponse
from ninja import Query, Router, Schema

from haulcast.api.schemas import COMMON_ERRORS, ProblemSchema
from haulcast.services.container import geocoding_service
from haulcast.services.geocoding import MAX_RESULTS

router = Router(tags=["geocoding"])

GEOCODE_CACHE_CONTROL: Final = (
    "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400"
)
DEFAULT_LIMIT: Final = 5
MAX_RAW_QUERY_CHARS: Final = 512
"""Bound on the raw input; the exact 2..120 character rule applies after normalisation."""


class GeocodeResult(Schema):
    """One candidate place. Every text field is plain data for the UI to render as text."""

    id: str
    label: str
    name: str
    region: str | None
    country: str | None
    country_code: str | None
    kind: str
    lat: float
    lon: float


class GeocodeResponse(Schema):
    """Body of ``GET /api/v1/geocode``: the normalised query and its candidates, best first."""

    query: str
    results: list[GeocodeResult]


@router.get(
    "/geocode",
    response={200: GeocodeResponse, 422: ProblemSchema, 503: ProblemSchema, **COMMON_ERRORS},
    operation_id="geocode",
    summary="Search places by free text (US-biased)",
)
def geocode(
    request: HttpRequest,
    response: HttpResponse,
    q: Annotated[str, Query(max_length=MAX_RAW_QUERY_CHARS)],
    limit: Annotated[int, Query(ge=1, le=MAX_RESULTS)] = DEFAULT_LIMIT,
) -> GeocodeResponse:
    """Return up to ``limit`` places matching ``q`` (2 to 120 characters once normalised)."""
    search = geocoding_service().search(q, limit)
    response["Cache-Control"] = GEOCODE_CACHE_CONTROL
    return GeocodeResponse(
        query=search.query,
        results=[GeocodeResult(**asdict(candidate)) for candidate in search.candidates],
    )
