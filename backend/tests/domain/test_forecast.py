"""Forecast selection at a checkpoint ETA (DOMAIN-CONTRACT section 5)."""

import math
from datetime import UTC, datetime, timedelta, timezone
from types import MappingProxyType
from zoneinfo import ZoneInfo

import pytest

from haulcast.domain import (
    VARIABLE_SPECS,
    HourlySeries,
    InvalidForecastError,
    NaiveDatetimeError,
    Semantics,
    VariableSpec,
    sample_at,
)

from .support import utc

START = utc(2026, 10, 20, 12)
SERIES = HourlySeries(
    start=START,
    values={
        "wind_speed_10m": (10.0, 20.0, 30.0, 40.0, 50.0),
        "wind_gusts_10m": (15.0, 25.0, 35.0, 45.0, 55.0),
        "rain": (0.0, 0.1, 0.2, None, 0.4),
        "showers": (0.0, 0.05, None, None, 0.1),
        "snowfall": (0.0, 0.0, 0.5, 1.0, 1.5),
        "temperature_2m": (-5.0, -4.0, -3.0, -2.0, -1.0),
        "weather_code": (0, 1, 2, 3, 61),
    },
)


def test_the_semantics_table_matches_the_contract_and_research() -> None:
    semantics = {name: spec.semantics for name, spec in VARIABLE_SPECS.items()}

    assert semantics == {
        "wind_speed_10m": Semantics.INSTANT,
        "temperature_2m": Semantics.INSTANT,
        "weather_code": Semantics.NEAREST,
        "rain": Semantics.PRECEDING_HOUR,
        "showers": Semantics.PRECEDING_HOUR,
        "snowfall": Semantics.PRECEDING_HOUR,
        "precipitation": Semantics.PRECEDING_HOUR,
        "wind_gusts_10m": Semantics.PRECEDING_HOUR,
    }
    assert [name for name, spec in VARIABLE_SPECS.items() if spec.signed] == ["temperature_2m"]


def test_on_the_hour_uses_the_exact_samples() -> None:
    sample = sample_at(SERIES, utc(2026, 10, 20, 13))

    assert sample.valid_time == utc(2026, 10, 20, 13)
    assert sample.wind_mph == 20.0
    assert sample.gust_mph == 25.0
    assert sample.rain_in_hr == pytest.approx(0.15)
    assert sample.snow_in_hr == 0.0
    assert sample.temperature_f == -4.0
    assert sample.weather_code == 1


def test_mid_hour_interpolates_instants_and_takes_the_hour_ending_after() -> None:
    sample = sample_at(SERIES, utc(2026, 10, 20, 13, 30))

    assert sample.wind_mph == 25.0
    assert sample.temperature_f == -3.5
    assert sample.gust_mph == 35.0
    assert sample.rain_in_hr == 0.2  # rain only: showers missing at 14:00
    assert sample.snow_in_hr == 0.5
    assert sample.weather_code == 1  # exactly half past: the earlier hour


def test_the_last_second_before_an_hour_still_belongs_to_it() -> None:
    eta = utc(2026, 10, 20, 14) - timedelta(seconds=1)

    sample = sample_at(SERIES, eta)

    assert sample.wind_mph == pytest.approx(20.0 + 10.0 * 3599 / 3600)
    assert sample.gust_mph == 35.0
    assert sample.weather_code == 2


def test_the_first_second_after_an_hour_starts_the_next_interval() -> None:
    sample = sample_at(SERIES, utc(2026, 10, 20, 13) + timedelta(seconds=1))

    assert sample.gust_mph == 35.0
    assert sample.weather_code == 1


@pytest.mark.parametrize(
    "eta",
    [utc(2026, 10, 20, 17), utc(2026, 10, 20, 18, 45), utc(2026, 10, 20, 11)],
    ids=["one-hour-past-the-end", "far-beyond", "on-the-hour-before-start"],
)
def test_beyond_the_series_is_unknown(eta: datetime) -> None:
    sample = sample_at(SERIES, eta)

    assert (sample.wind_mph, sample.gust_mph, sample.rain_in_hr, sample.snow_in_hr) == (None,) * 4
    assert (sample.temperature_f, sample.weather_code) == (None, None)


def test_partially_outside_the_series() -> None:
    before_start = sample_at(SERIES, utc(2026, 10, 20, 11, 30))
    near_end = sample_at(SERIES, utc(2026, 10, 20, 16, 30))

    assert before_start.wind_mph is None  # needs 11:00, which the series does not have
    assert before_start.gust_mph == 15.0  # the hour (11:00, 12:00] is stamped 12:00
    assert near_end.wind_mph is None
    assert near_end.gust_mph is None


def test_null_samples_are_unknown() -> None:
    sample = sample_at(SERIES, utc(2026, 10, 20, 15))

    assert sample.rain_in_hr is None
    assert sample.wind_mph == 40.0


def test_interpolation_needs_both_neighbours() -> None:
    series = HourlySeries(start=START, values={"wind_speed_10m": (10.0, None, 30.0)})

    assert sample_at(series, utc(2026, 10, 20, 12, 30)).wind_mph is None
    assert sample_at(series, utc(2026, 10, 20, 12)).wind_mph == 10.0


def test_absent_variables_are_unknown() -> None:
    series = HourlySeries(start=START, values={"temperature_2m": (50.0, 51.0)})

    sample = sample_at(series, utc(2026, 10, 20, 12, 15))

    assert (sample.wind_mph, sample.rain_in_hr, sample.weather_code) == (None, None, None)
    assert sample.temperature_f == 50.25


def test_invalid_risk_inputs_stay_visible_as_nan() -> None:
    series = HourlySeries(
        start=START,
        values={
            "wind_speed_10m": (-5.0, 10.0),
            "wind_gusts_10m": (math.nan, math.inf),
            "rain": (-0.1, 0.5),
            "showers": (0.2, 0.0),
            "snowfall": (-1.0, 0.0),
        },
    )

    sample = sample_at(series, utc(2026, 10, 20, 12, 30))

    assert sample.wind_mph is not None
    assert math.isnan(sample.wind_mph)  # never interpolated into a plausible value
    assert sample.gust_mph is not None
    assert math.isnan(sample.gust_mph) or math.isinf(sample.gust_mph)
    on_hour = sample_at(series, utc(2026, 10, 20, 12))
    assert on_hour.rain_in_hr is not None
    assert math.isnan(on_hour.rain_in_hr)  # -0.1 + 0.2 must not look like 0.1
    assert on_hour.snow_in_hr is not None
    assert math.isnan(on_hour.snow_in_hr)


def test_invalid_display_values_become_unknown() -> None:
    series = HourlySeries(
        start=START,
        values={"temperature_2m": (math.nan, 1.0), "weather_code": (2.5, -3.0)},
    )

    first = sample_at(series, utc(2026, 10, 20, 12))
    second = sample_at(series, utc(2026, 10, 20, 13))

    assert (first.temperature_f, first.weather_code) == (None, None)
    assert (second.temperature_f, second.weather_code) == (1.0, None)


def test_tz_naive_etas_are_rejected() -> None:
    with pytest.raises(NaiveDatetimeError):
        sample_at(SERIES, utc(2026, 10, 20, 13).replace(tzinfo=None))


def test_etas_in_any_zone_are_handled_in_utc_across_dst() -> None:
    denver = ZoneInfo("America/Denver")
    series = HourlySeries(
        start=utc(2026, 11, 1, 6), values={"wind_speed_10m": (1.0, 2.0, 3.0, 4.0)}
    )
    # 01:30 local happens twice on 2026-11-01: first in MDT (UTC-6), then in MST (UTC-7).
    first = sample_at(series, datetime(2026, 11, 1, 1, 30, fold=0, tzinfo=denver))
    second = sample_at(series, datetime(2026, 11, 1, 1, 30, fold=1, tzinfo=denver))

    assert first.valid_time == utc(2026, 11, 1, 7, 30)
    assert second.valid_time == utc(2026, 11, 1, 8, 30)
    assert (first.wind_mph, second.wind_mph) == (2.5, 3.5)
    assert first.valid_time.tzinfo is UTC


def test_the_semantics_table_is_data_a_variable_can_be_flipped() -> None:
    flipped = MappingProxyType(
        {**VARIABLE_SPECS, "wind_gusts_10m": VariableSpec(Semantics.INSTANT)}
    )
    eta = utc(2026, 10, 20, 13, 30)

    assert sample_at(SERIES, eta).gust_mph == 35.0
    assert sample_at(SERIES, eta, variables=flipped).gust_mph == 30.0


@pytest.mark.parametrize(
    ("start", "values", "error"),
    [
        (START.replace(tzinfo=None), {"rain": (0.0,)}, NaiveDatetimeError),
        (
            datetime(2026, 10, 20, 12, tzinfo=timezone(timedelta(hours=5))),
            {"rain": (0.0,)},
            InvalidForecastError,
        ),
        (datetime(2026, 10, 20, 12, 30, tzinfo=UTC), {"rain": (0.0,)}, InvalidForecastError),
        (START, {"rain": (0.0,), "snowfall": (0.0, 1.0)}, InvalidForecastError),
        (START, {"rain": ()}, InvalidForecastError),
        (START, {}, InvalidForecastError),
    ],
    ids=["naive", "not-utc", "not-on-the-hour", "ragged", "empty-array", "no-variables"],
)
def test_malformed_series_are_rejected(
    start: datetime, values: dict[str, tuple[float | None, ...]], error: type[Exception]
) -> None:
    with pytest.raises(error):
        HourlySeries(start=start, values=values)


def test_series_report_their_length() -> None:
    assert SERIES.hours == 5
    assert SERIES.end == utc(2026, 10, 20, 16)
