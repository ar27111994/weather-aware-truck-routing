"""Forecast adapters: provider forecasts as domain series, and the local time zone of a place."""

from datetime import UTC, datetime, timedelta

import pytest

import haulcast.services.forecasts as forecasts_module
from haulcast.domain import sample_at
from haulcast.providers.weather.base import HourlyForecast, LatticePoint
from haulcast.services.forecasts import FALLBACK_ZONE, hourly_series, local_zone

START = datetime(2026, 10, 20, 14, 0, tzinfo=UTC)


def forecast() -> HourlyForecast:
    """Three hours of weather in which every variable differs from every other."""
    return HourlyForecast(
        point=LatticePoint(397, -1050),
        model="best_match",
        start=START,
        wind_speed_mph=(10.0, 20.0, None),
        wind_gust_mph=(15.0, 25.0, 35.0),
        rain_in=(0.01, 0.02, 0.03),
        showers_in=(0.0, 0.1, 0.2),
        snowfall_in=(0.5, 1.0, 1.5),
        precipitation_in=(0.51, 1.12, 1.73),
        temperature_f=(40.0, 41.0, 42.0),
        weather_code=(3, None, 75),
    )


def test_the_series_carries_every_variable_under_its_open_meteo_name() -> None:
    series = hourly_series(forecast())

    assert series.start == START
    assert series.hours == 3
    assert series.values["wind_speed_10m"] == (10.0, 20.0, None)
    assert series.values["wind_gusts_10m"] == (15.0, 25.0, 35.0)
    assert series.values["rain"] == (0.01, 0.02, 0.03)
    assert series.values["showers"] == (0.0, 0.1, 0.2)
    assert series.values["snowfall"] == (0.5, 1.0, 1.5)
    assert series.values["precipitation"] == (0.51, 1.12, 1.73)
    assert series.values["temperature_2m"] == (40.0, 41.0, 42.0)
    assert series.values["weather_code"] == (3.0, None, 75.0)


def test_the_domain_reads_the_adapted_series_by_its_own_rules() -> None:
    series = hourly_series(forecast())

    sample = sample_at(series, START + timedelta(minutes=30))

    assert sample.wind_mph == 15.0  # instant: halfway between 10 and 20
    assert sample.gust_mph == 25.0  # preceding hour: the hour that ends at 15:00
    assert sample.rain_in_hr == pytest.approx(0.02 + 0.1)
    assert sample.snow_in_hr == 1.0
    assert sample.temperature_f == 40.5


@pytest.mark.parametrize(
    ("lat", "lon", "month", "zone", "offset_s"),
    [
        (39.7392, -104.9903, 10, "America/Denver", -6 * 3600),
        (39.7392, -104.9903, 1, "America/Denver", -7 * 3600),
        (40.7357, -74.1724, 10, "America/New_York", -4 * 3600),
        (34.0522, -118.2437, 7, "America/Los_Angeles", -7 * 3600),
        (33.4484, -112.074, 7, "America/Phoenix", -7 * 3600),
    ],
)
def test_the_zone_and_its_offset_are_those_of_the_place_at_the_instant(
    lat: float, lon: float, month: int, zone: str, offset_s: int
) -> None:
    assert local_zone(lat, lon, datetime(2026, month, 20, 18, 0, tzinfo=UTC)) == (zone, offset_s)


@pytest.mark.parametrize("unknown", ["", "Nowhere/Land"])
def test_a_place_without_a_known_zone_is_shown_in_utc(
    monkeypatch: pytest.MonkeyPatch, unknown: str
) -> None:
    monkeypatch.setattr(forecasts_module, "get_tz", lambda _lon, _lat: unknown)

    assert local_zone(0.0, 0.0, START) == (FALLBACK_ZONE, 0)
