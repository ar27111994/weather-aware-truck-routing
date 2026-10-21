"""The plan and heatmap documents: the JSON the API serves and the database stores.

One set of Pydantic models is both the persisted shape (``Plan.result`` / ``Plan.heatmap``) and the
OpenAPI response schema, so the committed ``shared/openapi.json`` cannot drift from what is served.
Every enumeration is declared from its single source: the domain's ``StrEnum`` classes
(``DecidedBy``, ``RouteStatus``, ``Factor``), the domain's ``RiskLevel`` identifiers, the
provider names and the checkpoint-interval list of the rules file. Frontend validators are tested
against these enums in the committed OpenAPI document.

Values are rounded where they are produced (``plan_assembly``), never here: a document is exactly
what is stored.
"""

from datetime import datetime
from typing import Annotated, Final, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from haulcast.domain import DecidedBy, Factor, RiskLevel, RouteStatus
from haulcast.providers.routing import osrm, valhalla
from haulcast.providers.weather import scenario as scenario_provider
from haulcast.providers.weather.openmeteo import OpenMeteoProvider
from haulcast.providers.weather.scenarios import ScenarioCatalog

HEATMAP_FRAME_COUNT: Final = 49
"""Hourly frames of a heatmap: forecast hours 0 to 48 from the departure hour."""

HEATMAP_STEP_MINUTES: Final = 60

LevelId = Annotated[str, Field(json_schema_extra={"enum": [level.id for level in RiskLevel]})]
"""Identifier of a risk level (``low`` to ``no_travel``), from the domain's ``RiskLevel``."""

SCENARIO_IDS: Final = tuple(summary.id for summary in ScenarioCatalog.load().summaries())
"""The ids of the demo scenarios under ``shared/scenarios``, in catalogue order (read at start)."""


def _in_catalogue(value: str) -> str:
    if value not in SCENARIO_IDS:
        raise ValueError(f"must be one of {', '.join(SCENARIO_IDS)}")
    return value


ScenarioId = Annotated[
    str, Field(json_schema_extra={"enum": list(SCENARIO_IDS)}), AfterValidator(_in_catalogue)
]
"""Identifier of a demo weather scenario, as published (an enum) and as enforced.

The request schema, the echo of the request and the sources of a plan all use it, so an id that
the catalogue does not have is refused wherever one is read, including a stored plan whose
scenario was renamed since.
"""

RoutingSourceId = Annotated[
    str, Field(json_schema_extra={"enum": [valhalla.PROVIDER_NAME, osrm.PROVIDER_NAME]})
]
WeatherSourceId = Annotated[
    str,
    Field(
        json_schema_extra={"enum": [OpenMeteoProvider.name, scenario_provider.PROVIDER_NAME]},
    ),
]

Latitude = Annotated[float, Field(ge=-90, le=90)]
Longitude = Annotated[float, Field(ge=-180, le=180)]


class _Document(BaseModel):
    """Base of every document: immutable, and unknown fields are an error."""

    model_config = ConfigDict(frozen=True, extra="forbid")


class PlaceDoc(_Document):
    """An origin or destination, normalized."""

    lat: Latitude
    lon: Longitude
    label: Annotated[str, Field(min_length=1, max_length=200)]


class RequestDoc(_Document):
    """The normalized request echo (coordinates to 4 decimals, departure to the minute)."""

    origin: PlaceDoc
    destination: PlaceDoc
    departure_time: datetime
    load_weight_lb: int
    sampling_interval_mi: int
    scenario: ScenarioId | None


class SourcesDoc(_Document):
    """Where each input came from; ``attribution`` must be shown to the user."""

    routing: RoutingSourceId
    weather: WeatherSourceId
    weather_model: str
    scenario: ScenarioId | None
    attribution: list[str]


class WeatherDoc(_Document):
    """The forecast read at a checkpoint's ETA; ``None`` marks a missing value."""

    valid_time: datetime
    wind_mph: float | None
    gust_mph: float | None
    rain_in_hr: float | None
    snow_in_hr: float | None
    temperature_f: float | None
    weather_code: int | None


class RiskDoc(_Document):
    """The risk assessment of a checkpoint; ``level`` is ``None`` when the weather is unknown."""

    level: LevelId | None
    factors: dict[Factor, LevelId | None]
    load_rule: str | None
    incomplete: bool
    reasons: list[str]


class CheckpointDoc(_Document):
    """A sampled point of a route with its weather, risk and the polyline stretch it paints."""

    index: int
    distance_mi: float
    lat: Latitude
    lon: Longitude
    eta: datetime
    utc_offset_s: int
    timezone: str
    owned_mi: float
    coord_start: int
    coord_end: int
    weather: WeatherDoc
    risk: RiskDoc


class MilesByLevelDoc(_Document):
    """Miles at each risk level; all five keys are always present."""

    low: float
    moderate: float
    high: float
    severe: float
    no_travel: float


class StatsDoc(_Document):
    """Mile-weighted risk statistics of a route."""

    miles_by_level: MilesByLevelDoc
    unknown_mi: float
    avg_risk: Annotated[float, Field(ge=0, le=4)] | None
    max_level: LevelId | None


class GeometryDoc(_Document):
    """The route as a GeoJSON ``LineString`` (``[lon, lat]``, simplified for display)."""

    type: Literal["LineString"]
    coordinates: list[tuple[float, float]]


class RouteDoc(_Document):
    """One ranked route option."""

    route_id: str
    label: str
    summary: str
    distance_mi: float
    duration_s: int
    departure_time: datetime
    arrival_time: datetime
    geometry: GeometryDoc
    cumulative_mi: list[float]
    cumulative_s: list[int]
    checkpoints: list[CheckpointDoc]
    stats: StatsDoc
    rank: Annotated[int, Field(ge=1)]
    recommended: bool


class RecommendationDoc(_Document):
    """Which route to take and why."""

    route_id: str
    status: RouteStatus
    decided_by: DecidedBy
    rationale: list[str]
    warnings: list[str]


class PlanDoc(_Document):
    """``POST /plans`` and ``GET /plans/{plan_id}``: a plan with up to three ranked routes."""

    plan_id: str
    created_at: datetime
    expires_at: datetime
    request: RequestDoc
    sources: SourcesDoc
    routes: list[RouteDoc]
    recommendation: RecommendationDoc
    warnings: list[str]


class GridDoc(_Document):
    """The heatmap grid (D-22): ``lat0`` / ``lon0`` is the south-west corner of cell (0, 0)."""

    lat0: Latitude
    lon0: Longitude
    dlat: Annotated[float, Field(gt=0)]
    dlon: Annotated[float, Field(gt=0)]
    rows: Annotated[int, Field(gt=0)]
    cols: Annotated[int, Field(gt=0)]


class FieldsDoc(_Document):
    """Frame-major arrays; ``risk`` is 0 to 4 or -1 (unknown), the rest ``None`` if unknown."""

    risk: list[Annotated[int, Field(ge=-1, le=4)]]
    wind_mph: list[float | None]
    gust_mph: list[float | None]
    rain_in_hr: list[float | None]
    snow_in_hr: list[float | None]


class HeatmapDoc(_Document):
    """``GET /plans/{plan_id}/heatmap``: forecast fields over the corridor, 49 hourly frames."""

    plan_id: str
    start_time: datetime
    frame_count: Literal[49]
    step_minutes: Literal[60]
    grid: GridDoc
    cells: list[int]
    fields: FieldsDoc
    load_weight_lb: int
    sources: SourcesDoc
    generated_at: datetime
