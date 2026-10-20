"""``/api/v1/plans``: create a plan, read it back, read its heatmap.

The endpoints are thin: the schemas validate the *shape* (strict types, ranges from the rules file,
unknown fields rejected, labels cleaned), the services do everything else. Responses are the
stored documents, pre-serialized by Pydantic: the OpenAPI schema is generated from the same
models (``haulcast.services.plan_document``), and the bytes are hashed into a strong ``ETag`` so
``If-None-Match`` answers 304 without re-sending a field that is a few hundred kilobytes.
"""

import hashlib
from typing import Annotated, Final

from django.http import HttpRequest, HttpResponse
from django.utils.cache import get_conditional_response
from ninja import Router, Schema
from pydantic import AfterValidator, AwareDatetime, BeforeValidator, ConfigDict, Field

from haulcast.api.schemas import COMMON_ERRORS, ProblemSchema
from haulcast.services.container import (
    heatmap_service,
    plan_service,
    risk_rules,
    scenario_catalog,
)
from haulcast.services.plan_document import HeatmapDoc, PlanDoc
from haulcast.services.plan_request import Place, PlanRequest, clean_label

router = Router(tags=["plans"])

CACHE_CONTROL: Final = "public, max-age=300, s-maxage=3600"
"""Plans and heatmaps never change once stored: browsers 5 minutes, the CDN an hour."""

JSON_MEDIA_TYPE: Final = "application/json"

_RULES: Final = risk_rules()
_INTERVALS: Final = _RULES.sampling_intervals_mi
_SCENARIO_IDS: Final = [summary.id for summary in scenario_catalog().summaries()]


def _clean(value: object) -> object:
    """Strip control characters from a label before its length is checked."""
    return clean_label(value) if isinstance(value, str) else value


def _text_only(value: object) -> object:
    """Accept a timestamp only as text: an RFC 3339 string, never an epoch number."""
    if not isinstance(value, str):
        raise ValueError("must be an RFC 3339 date-time string")  # noqa: TRY004 - pydantic needs ValueError
    return value


def _known_interval(value: int) -> int:
    if value not in _INTERVALS:
        allowed = ", ".join(str(interval) for interval in _INTERVALS)
        raise ValueError(f"must be one of {allowed}")
    return value


def _known_scenario(value: str) -> str:
    if value not in _SCENARIO_IDS:
        raise ValueError(f"must be one of {', '.join(_SCENARIO_IDS)}")
    return value


Latitude = Annotated[float, Field(strict=True, ge=-90, le=90, allow_inf_nan=False)]
Longitude = Annotated[float, Field(strict=True, ge=-180, le=180, allow_inf_nan=False)]
Departure = Annotated[AwareDatetime, BeforeValidator(_text_only)]
Label = Annotated[str, BeforeValidator(_clean), Field(min_length=1, max_length=200)]
LoadWeight = Annotated[int, Field(strict=True, ge=_RULES.load_min_lb, le=_RULES.load_max_lb)]
SamplingInterval = Annotated[
    int,
    Field(strict=True, json_schema_extra={"enum": list(_INTERVALS)}),
    AfterValidator(_known_interval),
]
ScenarioId = Annotated[
    str,
    Field(json_schema_extra={"enum": _SCENARIO_IDS}),
    AfterValidator(_known_scenario),
]


class PlaceSchema(Schema):
    """An origin or destination as the client sends it."""

    model_config = ConfigDict(extra="forbid")

    lat: Latitude
    lon: Longitude
    label: Label


class PlanRequestSchema(Schema):
    """Body of ``POST /plans``; unknown fields are rejected."""

    model_config = ConfigDict(extra="forbid")

    origin: PlaceSchema
    destination: PlaceSchema
    departure_time: Departure
    load_weight_lb: LoadWeight
    sampling_interval_mi: SamplingInterval
    scenario: ScenarioId | None = None

    def to_request(self) -> PlanRequest:
        """The service-level request (the service normalizes and hashes it)."""
        return PlanRequest(
            origin=Place(self.origin.lat, self.origin.lon, self.origin.label),
            destination=Place(self.destination.lat, self.destination.lon, self.destination.label),
            departure=self.departure_time,
            load_weight_lb=self.load_weight_lb,
            sampling_interval_mi=self.sampling_interval_mi,
            scenario=self.scenario,
        )


def _cacheable(request: HttpRequest, body: bytes) -> HttpResponse:
    """Serve ``body`` with a strong content-hash ETag; ``If-None-Match`` revalidation is a 304."""
    etag = f'"{hashlib.sha256(body).hexdigest()[:32]}"'
    response = HttpResponse(body, content_type=JSON_MEDIA_TYPE)
    response["ETag"] = etag
    response["Cache-Control"] = CACHE_CONTROL
    conditional = get_conditional_response(request, etag=etag, response=response)
    return conditional if conditional is not None else response


@router.post(
    "/plans",
    response={
        200: PlanDoc,
        201: PlanDoc,
        422: ProblemSchema,
        502: ProblemSchema,
        503: ProblemSchema,
        **COMMON_ERRORS,
    },
    operation_id="createPlan",
    summary="Compute a plan: up to three routes with weather risk at every checkpoint",
)
def create_plan(request: HttpRequest, payload: PlanRequestSchema) -> HttpResponse:
    """Create a plan (201, ``Location``) or return the identical recent one (200)."""
    outcome = plan_service().create(payload.to_request())
    response = HttpResponse(
        outcome.document.model_dump_json(),
        content_type=JSON_MEDIA_TYPE,
        status=201 if outcome.created else 200,
    )
    response["Location"] = f"/api/v1/plans/{outcome.document.plan_id}"
    return response


@router.get(
    "/plans/{plan_id}",
    response={200: PlanDoc, 304: None, 404: ProblemSchema, 503: ProblemSchema, **COMMON_ERRORS},
    operation_id="getPlan",
    summary="A stored plan (7 days), with a strong ETag",
)
def get_plan(request: HttpRequest, plan_id: str) -> HttpResponse:
    """Return the stored plan, or 404 when it is unknown or expired."""
    return _cacheable(request, plan_service().get(plan_id).model_dump_json().encode())


@router.get(
    "/plans/{plan_id}/heatmap",
    response={
        200: HeatmapDoc,
        304: None,
        404: ProblemSchema,
        502: ProblemSchema,
        503: ProblemSchema,
        **COMMON_ERRORS,
    },
    operation_id="getHeatmap",
    summary="The 49-frame corridor forecast field of a plan, computed on first request",
)
def get_heatmap(request: HttpRequest, plan_id: str) -> HttpResponse:
    """Return the plan's heatmap, computing and storing it on the first request."""
    return _cacheable(request, heatmap_service().get(plan_id).model_dump_json().encode())
