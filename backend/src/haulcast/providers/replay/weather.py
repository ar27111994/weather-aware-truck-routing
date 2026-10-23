"""The weather synthesiser: Open-Meteo forecast answers built from the recorded Denver week.

The recorded sample (``weather/openmeteo-denver-gmt-start-end-hour.json``) fixes the *shape* of an
answer: the variables, their unit labels and the envelope fields the adapter checks. The values come
from a *script*, a function of place and UTC hour, so a test can put a storm exactly where it needs
one. :func:`recorded_week` replays the recorded week cyclically (the same real, mild weather
everywhere) and is what replay mode answers with; :func:`benign` is light wind and no rain.
"""

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final, Self
from urllib.parse import parse_qs

import httpx

from haulcast.providers.replay.catalog import ReplayCatalog

SAMPLE_FILE: Final = "openmeteo-denver-gmt-start-end-hour.json"
"""The recorded answer (below ``weather/``) that gives the shape of every synthesised one."""

HOUR: Final = timedelta(hours=1)
_SECONDS_PER_HOUR: Final = 3_600
_GENERATION_TIME_MS: Final = 0.4
_ELEVATION_M: Final = 1_600.0

Values = dict[str, float | None]
Script = Callable[[float, float, datetime], Values]
"""``script(lat, lon, stamp)``: the hourly values at a place and a UTC hour."""


@dataclass(frozen=True, slots=True)
class WeatherSample:
    """The recorded Denver week: its first hour, its length, its unit labels and its values."""

    start: int
    """Unix time of the first recorded hour."""
    hours: int
    units: Mapping[str, str]
    columns: Mapping[str, Sequence[float | None]]
    """The recorded values of every variable, one per hour."""

    @classmethod
    def load(cls, catalog: ReplayCatalog) -> Self:
        """Read the sample from ``catalog``."""
        document = catalog.recorded("weather", SAMPLE_FILE)
        hourly = document["hourly"]
        times = hourly["time"]
        return cls(
            start=int(times[0]),
            hours=len(times),
            units=document["hourly_units"],
            columns={name: values for name, values in hourly.items() if name != "time"},
        )

    @property
    def variables(self) -> tuple[str, ...]:
        """The weather variables the sample records, in the order Open-Meteo sends them."""
        return tuple(self.columns)


def recorded_week(sample: WeatherSample) -> Script:
    """Return the script that replays ``sample``'s week cyclically, the same at every place."""

    def calm(_lat: float, _lon: float, stamp: datetime) -> Values:
        position = int((stamp.timestamp() - sample.start) // _SECONDS_PER_HOUR) % sample.hours
        return {name: sample.columns[name][position] for name in sample.variables}

    return calm


def benign(_lat: float, _lon: float, _stamp: datetime) -> Values:
    """Light wind, dry, everywhere and always."""
    return {
        "wind_speed_10m": 6.0,
        "wind_gusts_10m": 9.0,
        "rain": 0.0,
        "showers": 0.0,
        "snowfall": 0.0,
        "precipitation": 0.0,
        "temperature_2m": 60.0,
        "weather_code": 1,
    }


def _location_body(
    lat: float, lon: float, stamps: list[datetime], script: Script, sample: WeatherSample
) -> dict[str, object]:
    """One Open-Meteo location entry with the recorded unit labels."""
    rows = [script(lat, lon, stamp) for stamp in stamps]
    hourly: dict[str, object] = {"time": [int(stamp.timestamp()) for stamp in stamps]}
    hourly.update({name: [row[name] for row in rows] for name in sample.variables})
    return {
        "latitude": lat,
        "longitude": lon,
        "generationtime_ms": _GENERATION_TIME_MS,
        "utc_offset_seconds": 0,
        "timezone": "GMT",
        "timezone_abbreviation": "GMT",
        "elevation": _ELEVATION_M,
        "hourly_units": dict(sample.units),
        "hourly": hourly,
    }


def forecast_response(
    request: httpx.Request, script: Script, sample: WeatherSample
) -> httpx.Response:
    """Answer one Open-Meteo forecast request (a form POST) with the values of ``script``.

    One place gets one object, several places a list in request order, as the service does.
    """
    form = parse_qs(request.content.decode())
    lats = [float(item) for item in form["latitude"][0].split(",")]
    lons = [float(item) for item in form["longitude"][0].split(",")]
    start = datetime.strptime(form["start_hour"][0], "%Y-%m-%dT%H:%M").replace(tzinfo=UTC)
    end = datetime.strptime(form["end_hour"][0], "%Y-%m-%dT%H:%M").replace(tzinfo=UTC)
    stamps = [start + HOUR * hour for hour in range(int((end - start) / HOUR) + 1)]
    bodies = [
        _location_body(lat, lon, stamps, script, sample)
        for lat, lon in zip(lats, lons, strict=True)
    ]
    return httpx.Response(200, json=bodies[0] if len(bodies) == 1 else bodies)
