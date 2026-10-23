"""Tests of the weather synthesiser: the recorded Denver week in Open-Meteo's wire format."""

from datetime import UTC, datetime, timedelta

import httpx
import pytest

from haulcast.providers.replay.catalog import ReplayCatalog
from haulcast.providers.replay.transport import ReplayTransport
from haulcast.providers.replay.weather import (
    SAMPLE_FILE,
    WeatherSample,
    benign,
    forecast_response,
    recorded_week,
)
from haulcast.providers.weather.base import HourWindow, LatticePoint
from haulcast.providers.weather.openmeteo import DEFAULT_URL, OpenMeteoProvider
from tests.providers.replay.conftest import upstream

START = datetime(2026, 10, 20, 14, tzinfo=UTC)


@pytest.fixture(scope="session")
def sample(catalog: ReplayCatalog) -> WeatherSample:
    return WeatherSample.load(catalog)


def _form(lats: str, lons: str) -> httpx.Request:
    return httpx.Request(
        "POST",
        DEFAULT_URL,
        data={
            "latitude": lats,
            "longitude": lons,
            "start_hour": "2026-10-20T14:00",
            "end_hour": "2026-10-20T16:00",
            "hourly": "wind_speed_10m",
        },
    )


def test_the_sample_is_the_recorded_denver_week(
    catalog: ReplayCatalog, sample: WeatherSample
) -> None:
    document = catalog.recorded("weather", SAMPLE_FILE)
    hourly = document["hourly"]

    assert sample.start == hourly["time"][0]
    assert sample.hours == len(hourly["time"])
    assert sample.variables == tuple(name for name in hourly if name != "time")
    assert dict(sample.units) == document["hourly_units"]


def test_the_recorded_week_tells_the_recorded_hours_and_then_repeats(sample: WeatherSample) -> None:
    calm = recorded_week(sample)
    first = datetime.fromtimestamp(sample.start, UTC)

    assert calm(0.0, 0.0, first) == {name: sample.columns[name][0] for name in sample.variables}
    later = first + timedelta(hours=3)
    assert calm(40.0, -105.0, later + timedelta(hours=sample.hours)) == calm(1.0, 2.0, later)
    assert calm(40.0, -105.0, later) == {name: sample.columns[name][3] for name in sample.variables}


def test_benign_weather_is_light_dry_and_the_same_everywhere(sample: WeatherSample) -> None:
    here = benign(40.0, -105.0, START)

    assert set(sample.variables) <= set(here)
    assert here == benign(10.0, 20.0, START + timedelta(days=2))
    assert here["wind_speed_10m"] == 6.0
    assert here["precipitation"] == 0.0


def test_one_place_gets_one_forecast_and_several_places_a_list(sample: WeatherSample) -> None:
    calm = recorded_week(sample)

    one = forecast_response(_form("39.7", "-105.0"), calm, sample).json()
    several = forecast_response(_form("39.7,40.7", "-105.0,-111.9"), calm, sample).json()

    assert one["timezone"] == "GMT"
    assert one["hourly_units"] == dict(sample.units)
    assert len(one["hourly"]["time"]) == 3
    assert [entry["latitude"] for entry in several] == [39.7, 40.7]
    assert several[0] == one


def test_the_open_meteo_adapter_reads_the_replayed_forecast(
    transport: ReplayTransport, sample: WeatherSample
) -> None:
    provider = OpenMeteoProvider(upstream(OpenMeteoProvider.name, transport))
    points = [LatticePoint(397, -1050), LatticePoint(407, -1119)]

    forecasts = provider.fetch(points, HourWindow(START, 49))

    assert set(forecasts) == set(points)
    here, there = (forecasts[point] for point in points)
    assert len(here.wind_speed_mph) == 49
    assert here.wind_speed_mph == there.wind_speed_mph
    expected = recorded_week(sample)(0.0, 0.0, START)
    assert here.temperature_f[0] == pytest.approx(expected["temperature_2m"])
