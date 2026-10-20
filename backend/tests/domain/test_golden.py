"""Golden trips (DOMAIN-CONTRACT section 10): three fixture routes x scripted weather, end to end.

Each fixture in ``tests/fixtures/domain/`` holds candidate routes (polyline, cumulative seconds,
provider length) and scripted hourly weather by distance zone. The whole pipeline runs on it:
``build_path`` -> ``plan_checkpoints`` -> ``sample_at`` -> ``assess`` -> ``summarize`` ->
``rank_routes``, and the result is compared with a reviewed JSON snapshot (syrupy). Floats are
rounded in the snapshot so 1-ulp differences between platform math libraries cannot flip it.
"""

import json
import math
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any

import pytest
from syrupy.assertion import SnapshotAssertion
from syrupy.extensions.json import JSONSnapshotExtension

from haulcast.domain import (
    Assessment,
    Checkpoint,
    HourlySeries,
    RiskLevel,
    RouteCandidate,
    RouteRiskStats,
    WeatherSample,
    assess,
    build_path,
    plan_checkpoints,
    rank_routes,
    sample_at,
    summarize,
)
from tests.domain.support import FIXTURES_DIR, RULES

TRIPS = ("urban", "regional", "long")
_DIGITS = 6
_WEATHER_DIGITS = 4


@pytest.fixture
def snapshot_json(snapshot: SnapshotAssertion) -> SnapshotAssertion:
    return snapshot.use_extension(JSONSnapshotExtension)


def load_trip(name: str) -> dict[str, Any]:
    trip: dict[str, Any] = json.loads(
        (FIXTURES_DIR / f"trip-{name}.json").read_text(encoding="utf-8")
    )
    return trip


def zone_series(zone: Mapping[str, Any], start: datetime, hours: int) -> HourlySeries:
    """Expand a zone's script: a constant, or ``start + step * hour``; ``missing`` -> nulls."""
    values: dict[str, tuple[float | None, ...]] = {}
    for variable, spec in zone["hourly"].items():
        if isinstance(spec, Mapping):
            values[variable] = tuple(
                round(spec["start"] + spec["step"] * hour, 6) for hour in range(hours)
            )
        else:
            values[variable] = (float(spec),) * hours
    for variable in zone.get("missing", ()):
        values[variable] = (None,) * hours
    return HourlySeries(start=start, values=values)


def zone_for(zones: Sequence[Mapping[str, Any]], distance_mi: float) -> Mapping[str, Any]:
    """The first zone reaching ``distance_mi`` (``until_mi`` null = to the destination)."""
    for zone in zones:
        until = zone["until_mi"]
        if until is None or distance_mi <= until:
            return zone
    message = f"no weather zone covers {distance_mi} mi"
    raise LookupError(message)


def level_id(level: RiskLevel | None) -> str | None:
    return None if level is None else level.id


def rounded(value: float | None, digits: int = _DIGITS) -> float | None:
    return None if value is None else round(value, digits)


def checkpoint_json(
    checkpoint: Checkpoint, sample: WeatherSample, assessment: Assessment
) -> dict[str, Any]:
    return {
        "index": checkpoint.index,
        "distance_mi": rounded(checkpoint.distance_mi),
        "lon": rounded(checkpoint.lon),
        "lat": rounded(checkpoint.lat),
        "eta": checkpoint.eta.isoformat(timespec="seconds"),
        "owned_mi": rounded(checkpoint.owned_mi),
        "weather": {
            "valid_time": sample.valid_time.isoformat(timespec="seconds"),
            "wind_mph": rounded(sample.wind_mph, _WEATHER_DIGITS),
            "gust_mph": rounded(sample.gust_mph, _WEATHER_DIGITS),
            "rain_in_hr": rounded(sample.rain_in_hr, _WEATHER_DIGITS),
            "snow_in_hr": rounded(sample.snow_in_hr, _WEATHER_DIGITS),
            "temperature_f": rounded(sample.temperature_f, _WEATHER_DIGITS),
            "weather_code": sample.weather_code,
        },
        "risk": {
            "level": level_id(assessment.level),
            "factors": {factor.value: level_id(lv) for factor, lv in assessment.factors.items()},
            "load_rule": assessment.load_rule,
            "incomplete": assessment.incomplete,
            "reasons": list(assessment.reasons),
            "warnings": list(assessment.warnings),
        },
    }


def stats_json(stats: RouteRiskStats) -> dict[str, Any]:
    return {
        "miles_by_level": {lv.id: rounded(mi) for lv, mi in stats.miles_by_level.items()},
        "unknown_mi": rounded(stats.unknown_mi),
        "avg_risk": rounded(stats.avg_risk),
        "max_level": level_id(stats.max_level),
    }


def plan_trip(trip: Mapping[str, Any]) -> dict[str, Any]:
    """Run the whole domain pipeline on one fixture trip and return its JSON-able result."""
    departure = datetime.fromisoformat(trip["departure"])
    weather_start = datetime.fromisoformat(trip["weather_start"])
    routes: list[dict[str, Any]] = []
    candidates: list[RouteCandidate] = []
    for spec in trip["routes"]:
        path = build_path(
            [(lon, lat) for lon, lat in spec["coords"]], spec["cum_s"], spec["length_mi"]
        )
        checkpoints = plan_checkpoints(path, trip["interval_mi"], departure)
        samples = [
            sample_at(
                zone_series(
                    zone_for(spec["zones"], checkpoint.distance_mi),
                    weather_start,
                    trip["weather_hours"],
                ),
                checkpoint.eta,
            )
            for checkpoint in checkpoints
        ]
        assessments = [assess(sample, trip["load_lb"], RULES) for sample in samples]
        stats = summarize(checkpoints, assessments)
        candidates.append(
            RouteCandidate(
                route_id=spec["route_id"],
                duration_s=path.duration_s,
                distance_mi=path.length_mi,
                stats=stats,
                label=spec["label"],
            )
        )
        routes.append(
            {
                "route_id": spec["route_id"],
                "distance_mi": rounded(path.length_mi),
                "duration_s": path.duration_s,
                "checkpoints": [
                    checkpoint_json(*row)
                    for row in zip(checkpoints, samples, assessments, strict=True)
                ],
                "stats": stats_json(stats),
            }
        )
    ranking = rank_routes(candidates, RULES)
    return {
        "routes": routes,
        "ranking": {
            "order": list(ranking.order),
            "recommended_id": ranking.recommended_id,
            "decided_by": ranking.decided_by.value,
            "status": ranking.status.value,
            "rationale": list(ranking.rationale),
            "warnings": list(ranking.warnings),
        },
    }


@pytest.mark.parametrize("trip", TRIPS)
def test_golden_trip_matches_the_reviewed_snapshot(
    trip: str, snapshot_json: SnapshotAssertion
) -> None:
    assert plan_trip(load_trip(trip)) == snapshot_json


@pytest.mark.parametrize("trip", TRIPS)
def test_golden_trip_miles_add_up_to_each_route_length(trip: str) -> None:
    for route in plan_trip(load_trip(trip))["routes"]:
        stats = route["stats"]
        total = math.fsum([*stats["miles_by_level"].values(), stats["unknown_mi"]])
        assert total == pytest.approx(route["distance_mi"], abs=1e-5)
