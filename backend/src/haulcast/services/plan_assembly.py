"""Assemble plan documents from domain results: whole-second times, rounding, sources, warnings.

All presentation rounding lives here, once: ETAs to the whole second (and the forecast is read at
the ETA shown, so anyone can reproduce a checkpoint's weather from the response alone), miles
to 0.1 (the precision the ranking compares at), cumulative miles to 0.01, rain and snow to
0.001 in/hr, wind, gust and temperature to 0.1. A non-finite reading (invalid provider data) is
shown as unknown; the assessment already flagged it.
"""

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Final

from haulcast.domain import (
    Assessment,
    Checkpoint,
    RiskLevel,
    RouteRiskStats,
    WeatherSample,
)
from haulcast.providers.routing.base import RouteOption, RoutingResult
from haulcast.providers.weather import scenario as scenario_provider
from haulcast.providers.weather.openmeteo import MODEL, OPENMETEO_ATTRIBUTION, OpenMeteoProvider
from haulcast.providers.weather.scenario import ScenarioAnchor
from haulcast.services.plan_document import (
    CheckpointDoc,
    GeometryDoc,
    MilesByLevelDoc,
    RiskDoc,
    RouteDoc,
    SourcesDoc,
    StatsDoc,
    WeatherDoc,
)
from haulcast.services.plan_geometry import DisplayGeometry

OSM_ATTRIBUTION: Final = "© OpenStreetMap contributors"
SCENARIO_NOTICE: Final = "Simulated weather — not a forecast."
"""Shown with every scenario result (D-13): scenarios are demonstrations, never forecasts."""

_HALF_SECOND_US: Final = 500_000
_SECONDS_PER_DAY: Final = 86_400
_MAX_ASSESSMENT_NOTES: Final = 3


def round_to_second(moment: datetime) -> datetime:
    """Round ``moment`` to the nearest whole second (halves go up)."""
    whole = moment.replace(microsecond=0)
    return whole + timedelta(seconds=1) if moment.microsecond >= _HALF_SECOND_US else whole


def whole_seconds(seconds: float) -> int:
    """Round a non-negative duration to whole seconds, by the rule :func:`round_to_second` uses.

    Durations, cumulative seconds and ETAs all round this way, so a route's arrival time is exactly
    its departure plus its duration and equals its last checkpoint's ETA.
    """
    delta = timedelta(seconds=seconds)
    return delta.days * _SECONDS_PER_DAY + delta.seconds + (delta.microseconds >= _HALF_SECOND_US)


def rounded(value: float | None, digits: int) -> float | None:
    """Round ``value``; ``None`` and non-finite readings become ``None`` (unknown)."""
    if value is None or not math.isfinite(value):
        return None
    return round(value, digits)


def _level_id(level: RiskLevel | None) -> str | None:
    return None if level is None else level.id


def weather_document(sample: WeatherSample) -> WeatherDoc:
    """The forecast values read at a checkpoint, rounded for display."""
    return WeatherDoc(
        valid_time=sample.valid_time,
        wind_mph=rounded(sample.wind_mph, 1),
        gust_mph=rounded(sample.gust_mph, 1),
        rain_in_hr=rounded(sample.rain_in_hr, 3),
        snow_in_hr=rounded(sample.snow_in_hr, 3),
        temperature_f=rounded(sample.temperature_f, 1),
        weather_code=sample.weather_code,
    )


def risk_document(assessment: Assessment) -> RiskDoc:
    """The risk of a checkpoint: level, per-factor levels, the load rule that fired, reasons."""
    return RiskDoc(
        level=_level_id(assessment.level),
        factors={factor: _level_id(level) for factor, level in assessment.factors.items()},
        load_rule=assessment.load_rule,
        incomplete=assessment.incomplete,
        reasons=list(assessment.reasons),
    )


def checkpoint_document(
    checkpoint: Checkpoint,
    sample: WeatherSample,
    assessment: Assessment,
    span: tuple[int, int],
    zone: tuple[str, int],
) -> CheckpointDoc:
    """One checkpoint of a route: position, whole-second ETA, local zone, weather and risk."""
    return CheckpointDoc(
        index=checkpoint.index,
        distance_mi=round(checkpoint.distance_mi, 1),
        lat=round(checkpoint.lat, 5),
        lon=round(checkpoint.lon, 5),
        eta=round_to_second(checkpoint.eta),
        utc_offset_s=zone[1],
        timezone=zone[0],
        owned_mi=round(checkpoint.owned_mi, 2),
        coord_start=span[0],
        coord_end=span[1],
        weather=weather_document(sample),
        risk=risk_document(assessment),
    )


def stats_document(stats: RouteRiskStats) -> StatsDoc:
    """Miles per level (all five always), unknown miles, average risk and the worst level."""
    return StatsDoc(
        miles_by_level=MilesByLevelDoc(
            **{level.id: round(stats.miles_by_level[level], 1) for level in RiskLevel}
        ),
        unknown_mi=round(stats.unknown_mi, 1),
        avg_risk=None if stats.avg_risk is None else round(stats.avg_risk, 3),
        max_level=_level_id(stats.max_level),
    )


def rounded_cumulative(display: DisplayGeometry) -> tuple[tuple[float, ...], tuple[int, ...]]:
    """Cumulative miles to 0.01 and seconds to whole seconds, as stored in the document."""
    return (
        tuple(round(miles, 2) for miles in display.cum_mi),
        tuple(whole_seconds(seconds) for seconds in display.cum_s),
    )


def scenario_anchor(
    coords: Sequence[tuple[float, float]],
    cumulative_mi: Sequence[float],
    cumulative_s: Sequence[int],
    departure: datetime,
) -> ScenarioAnchor:
    """The anchor of a scenario: the fastest route *as stored in its document*.

    Built from the rounded document arrays on both sides (when the plan is made and when the
    heatmap is computed later), so a scenario heatmap agrees with the plan's checkpoints exactly.
    """
    return ScenarioAnchor(
        coords=tuple(coords),
        cum_mi=tuple(cumulative_mi),
        cum_s=tuple(float(seconds) for seconds in cumulative_s),
        departure=departure,
    )


@dataclass(frozen=True, slots=True)
class ScoredRoute:
    """A route with everything its document needs."""

    route_id: str
    label: str
    option: RouteOption
    display: DisplayGeometry
    checkpoints: tuple[CheckpointDoc, ...]
    stats: RouteRiskStats


def route_document(
    scored: ScoredRoute, *, departure: datetime, rank: int, recommended: bool
) -> RouteDoc:
    """The document of one ranked route."""
    cumulative_mi, cumulative_s = rounded_cumulative(scored.display)
    duration_s = whole_seconds(scored.option.duration_s)
    return RouteDoc(
        route_id=scored.route_id,
        label=scored.label,
        summary=scored.option.summary,
        distance_mi=round(scored.option.distance_mi, 1),
        duration_s=duration_s,
        departure_time=departure,
        arrival_time=departure + timedelta(seconds=duration_s),
        geometry=GeometryDoc(type="LineString", coordinates=list(scored.display.coords)),
        cumulative_mi=list(cumulative_mi),
        cumulative_s=list(cumulative_s),
        checkpoints=list(scored.checkpoints),
        stats=stats_document(scored.stats),
        rank=rank,
        recommended=recommended,
    )


def sources_document(routing: RoutingResult, scenario_id: str | None) -> SourcesDoc:
    """Where routes and weather came from, with the notices that must be displayed."""
    if scenario_id is None:
        weather, model, notice = OpenMeteoProvider.name, MODEL, OPENMETEO_ATTRIBUTION
    else:
        weather, model, notice = (
            scenario_provider.PROVIDER_NAME,
            scenario_provider.MODEL_NAME,
            SCENARIO_NOTICE,
        )
    return SourcesDoc(
        routing=routing.provider,
        weather=weather,
        weather_model=model,
        scenario=scenario_id,
        attribution=[OSM_ATTRIBUTION, notice],
    )


def weather_gap_warning(label: str, unknown: int, total: int, unknown_mi: float) -> str:
    """Tell the traveller that part of a route has no weather and is not scored."""
    return (
        f"{label}: weather is missing at {unknown} of {total} checkpoints "
        f"({unknown_mi:.1f} mi); that stretch's risk is shown as unknown."
    )


def assessment_notes(assessments: Iterable[Assessment]) -> list[str]:
    """The distinct data-quality notes of the assessments, first seen first, a few at most."""
    notes = dict.fromkeys(note for assessment in assessments for note in assessment.warnings)
    return list(notes)[:_MAX_ASSESSMENT_NOTES]
