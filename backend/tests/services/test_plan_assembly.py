"""Assembling documents: rounding rules, whole-second times, sources and warnings."""

from datetime import UTC, datetime, timedelta

import pytest

from haulcast.domain import Assessment, Factor, RiskLevel, RouteRiskStats, WeatherSample
from haulcast.providers.routing.base import RoutingResult
from haulcast.services.plan_assembly import (
    OSM_ATTRIBUTION,
    SCENARIO_NOTICE,
    assessment_notes,
    round_to_second,
    rounded,
    sources_document,
    stats_document,
    weather_document,
    weather_gap_warning,
    whole_seconds,
)

START = datetime(2026, 10, 20, 14, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    ("microsecond", "expected_second"),
    [(0, 0), (1, 0), (499_999, 0), (500_000, 1), (999_999, 1)],
)
def test_times_round_to_the_nearest_second_halves_up(
    microsecond: int, expected_second: int
) -> None:
    moment = START.replace(microsecond=microsecond)

    assert round_to_second(moment) == START + timedelta(seconds=expected_second)


@pytest.mark.parametrize(
    ("seconds", "expected"),
    [
        (0.0, 0),
        (59.4999, 59),
        (59.5, 60),
        (71_730.5, 71_731),
        (71_730.4, 71_730),
        (90_000.7, 90_001),
    ],
)
def test_durations_round_the_same_way_as_times(seconds: float, expected: int) -> None:
    assert whole_seconds(seconds) == expected


@pytest.mark.parametrize("seconds", [0.0, 12.5, 3_599.5, 71_730.5, 123_456.789])
def test_an_arrival_is_exactly_the_departure_plus_the_rounded_duration(seconds: float) -> None:
    arrival = round_to_second(START + timedelta(seconds=seconds))

    assert arrival == START + timedelta(seconds=whole_seconds(seconds))


@pytest.mark.parametrize(
    ("value", "digits", "expected"),
    [
        (None, 1, None),
        (float("nan"), 1, None),
        (float("inf"), 3, None),
        (float("-inf"), 3, None),
        (3.14159, 2, 3.14),
        (0.0004, 3, 0.0),
    ],
)
def test_readings_are_rounded_and_unusable_ones_are_unknown(
    value: float | None, digits: int, expected: float | None
) -> None:
    assert rounded(value, digits) == expected


def test_an_invalid_reading_is_shown_as_unknown_in_the_weather_block() -> None:
    sample = WeatherSample(
        valid_time=START,
        wind_mph=float("nan"),
        gust_mph=12.345,
        rain_in_hr=0.12345,
        snow_in_hr=None,
        temperature_f=48.26,
        weather_code=3,
    )

    document = weather_document(sample)

    assert document.wind_mph is None
    assert document.gust_mph == 12.3
    assert document.rain_in_hr == 0.123
    assert document.snow_in_hr is None
    assert document.temperature_f == 48.3
    assert document.weather_code == 3


def test_the_statistics_always_carry_all_five_levels() -> None:
    stats = RouteRiskStats(
        miles_by_level={
            RiskLevel.LOW: 480.14,
            RiskLevel.MODERATE: 32.26,
            RiskLevel.HIGH: 0.0,
            RiskLevel.SEVERE: 0.0,
            RiskLevel.NO_TRAVEL: 0.0,
        },
        unknown_mi=0.04,
        avg_risk=0.06349,
        max_level=RiskLevel.MODERATE,
    )

    document = stats_document(stats)

    assert document.model_dump() == {
        "miles_by_level": {
            "low": 480.1,
            "moderate": 32.3,
            "high": 0.0,
            "severe": 0.0,
            "no_travel": 0.0,
        },
        "unknown_mi": 0.0,
        "avg_risk": 0.063,
        "max_level": "moderate",
    }


def test_statistics_with_nothing_known_have_no_average_and_no_worst_level() -> None:
    stats = RouteRiskStats(
        miles_by_level=dict.fromkeys(RiskLevel, 0.0),
        unknown_mi=100.0,
        avg_risk=None,
        max_level=None,
    )

    document = stats_document(stats)

    assert (document.avg_risk, document.max_level, document.unknown_mi) == (None, None, 100.0)


def assessment(*warnings: str) -> Assessment:
    return Assessment(
        level=RiskLevel.LOW,
        factors={Factor.WIND: RiskLevel.LOW, Factor.RAIN: None, Factor.SNOW: None},
        load_rule=None,
        incomplete=True,
        reasons=(),
        warnings=warnings,
    )


def test_data_quality_notes_are_distinct_in_order_and_few() -> None:
    notes = assessment_notes(
        [assessment("a", "b"), assessment("b", "c"), assessment(), assessment("d", "a")]
    )

    assert notes == ["a", "b", "c"]


def test_a_weather_gap_is_described_with_its_miles() -> None:
    assert weather_gap_warning("Route B", 3, 22, 61.25) == (
        "Route B: weather is missing at 3 of 22 checkpoints (61.2 mi); "
        "that stretch's risk is shown as unknown."
    )


def test_real_weather_credits_open_meteo_and_scenarios_say_they_are_simulated() -> None:
    routing = RoutingResult(provider="osrm", routes=())

    real = sources_document(routing, None)
    simulated = sources_document(routing, "calm")

    assert real.model_dump() == {
        "routing": "osrm",
        "weather": "open-meteo",
        "weather_model": "best_match",
        "scenario": None,
        "attribution": [OSM_ATTRIBUTION, "Weather data by Open-Meteo.com (CC BY 4.0)"],
    }
    assert simulated.model_dump() == {
        "routing": "osrm",
        "weather": "scenario",
        "weather_model": "scenario",
        "scenario": "calm",
        "attribution": [OSM_ATTRIBUTION, SCENARIO_NOTICE],
    }
