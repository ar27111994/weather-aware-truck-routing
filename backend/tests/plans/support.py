"""Shared helpers of the plan and heatmap tests.

Routes are T1's *recorded* Valhalla and OSRM responses served through the real adapters and the
real routing chain. Weather is a scripted Open-Meteo upstream: it answers with the exact shape and
unit labels of the recorded sample (``openmeteo-denver-gmt-start-end-hour.json``) but its
values come from a script, so a test can place a storm exactly where and when it needs one.
"""

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import parse_qs

import httpx
import respx

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "providers"
VALHALLA_URL = "https://valhalla1.openstreetmap.de/route"
OSRM_URL = "https://router.project-osrm.org/route/v1/driving/"
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
PLANS = "/api/v1/plans"
HOUR = timedelta(hours=1)


class ApiResponse(Protocol):
    """What the tests read from a Django test-client response."""

    @property
    def status_code(self) -> int: ...

    @property
    def content(self) -> bytes: ...

    def json(self) -> dict[str, Any]: ...

    def __getitem__(self, header: str) -> str: ...


Values = dict[str, float | None]
Script = Callable[[float, float, datetime], Values]
"""``script(lat, lon, stamp)``: the hourly values at a place and a UTC hour."""


@dataclass(frozen=True)
class Trip:
    """A recorded trip: its coordinates and the recorded provider answers for it."""

    name: str
    origin: tuple[float, float]
    destination: tuple[float, float]
    origin_label: str
    destination_label: str
    valhalla: str
    osrm: str


SLC_DENVER = Trip(
    "slc-den",
    (40.7608, -111.891),
    (39.7392, -104.9903),
    "Salt Lake City, Utah, United States",
    "Denver, Colorado, United States",
    "valhalla-slc-den-truck-alt2.json",
    "osrm-slc-den-alt3.json",
)
CHICAGO_DENVER = Trip(
    "chi-den",
    (41.8781, -87.6298),
    (39.7392, -104.9903),
    "Chicago, Illinois, United States",
    "Denver, Colorado, United States",
    "valhalla-chi-den-truck-alt2.json",
    "osrm-chi-den-alt3.json",
)
NEWARK_JERSEY_CITY = Trip(
    "newark-jc",
    (40.7357, -74.1724),
    (40.7178, -74.0431),
    "Newark, New Jersey, United States",
    "Jersey City, New Jersey, United States",
    "valhalla-newark-jc-truck-alt2.json",
    "osrm-newark-jc-alt3.json",
)
LA_PHOENIX = Trip(
    "la-phx",
    (34.0522, -118.2437),
    (33.4484, -112.074),
    "Los Angeles, California, United States",
    "Phoenix, Arizona, United States",
    "valhalla-la-phx-truck-alt2.json",
    "osrm-la-phx-alt3.json",
)
TRIPS = (SLC_DENVER, CHICAGO_DENVER, NEWARK_JERSEY_CITY, LA_PHOENIX)


def recorded(kind: str, name: str) -> dict[str, Any]:
    """A recorded provider response from ``tests/fixtures/providers/<kind>``."""
    document: dict[str, Any] = json.loads((FIXTURES / kind / name).read_text(encoding="utf-8"))
    return document


def mock_routing(
    router: respx.MockRouter, *trips: Trip
) -> tuple[respx.Route, dict[str, respx.Route]]:
    """Serve the recorded Valhalla and OSRM answers of ``trips``; return both routes' call logs."""
    by_start = {(trip.origin, trip.destination): trip for trip in trips}

    def valhalla(request: httpx.Request) -> httpx.Response:
        first, second = json.loads(request.content)["locations"]
        trip = by_start[((first["lat"], first["lon"]), (second["lat"], second["lon"]))]
        return httpx.Response(200, json=recorded("routing", trip.valhalla))

    truck = router.post(VALHALLA_URL).mock(side_effect=valhalla)
    cars = {
        trip.name: router.get(
            url__regex=re.escape(OSRM_URL)
            + re.escape(
                f"{trip.origin[1]:.6f},{trip.origin[0]:.6f};"
                f"{trip.destination[1]:.6f},{trip.destination[0]:.6f}"
            )
        ).mock(return_value=httpx.Response(200, json=recorded("routing", trip.osrm)))
        for trip in trips
    }
    return truck, cars


# --------------------------------------------------------------------------- scripted weather

_SAMPLE = recorded("weather", "openmeteo-denver-gmt-start-end-hour.json")
SAMPLE_START = _SAMPLE["hourly"]["time"][0]
SAMPLE_HOURS = len(_SAMPLE["hourly"]["time"])
UNITS = _SAMPLE["hourly_units"]
VARIABLES = tuple(name for name in _SAMPLE["hourly"] if name != "time")


def calm(lat: float, lon: float, stamp: datetime) -> Values:  # noqa: ARG001 - same weather everywhere
    """The recorded Denver week, replayed cyclically: real, mild, and the same everywhere."""
    position = int((stamp.timestamp() - SAMPLE_START) // 3600) % SAMPLE_HOURS
    return {name: _SAMPLE["hourly"][name][position] for name in VARIABLES}


def benign(lat: float, lon: float, stamp: datetime) -> Values:  # noqa: ARG001
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


def location_body(lat: float, lon: float, stamps: list[datetime], script: Script) -> dict[str, Any]:
    """One Open-Meteo location entry with the recorded unit labels."""
    rows = [script(lat, lon, stamp) for stamp in stamps]
    hourly: dict[str, Any] = {"time": [int(stamp.timestamp()) for stamp in stamps]}
    hourly.update({name: [row[name] for row in rows] for name in VARIABLES})
    return {
        "latitude": lat,
        "longitude": lon,
        "generationtime_ms": 0.4,
        "utc_offset_seconds": 0,
        "timezone": "GMT",
        "timezone_abbreviation": "GMT",
        "elevation": 1600.0,
        "hourly_units": UNITS,
        "hourly": hourly,
    }


class WeatherUpstream:
    """A scripted Open-Meteo: records which lattice points each call asked for."""

    def __init__(self, router: respx.MockRouter, script: Script = calm) -> None:
        self.script = script
        self.route = router.post(OPEN_METEO_URL).mock(side_effect=self._respond)

    def _respond(self, request: httpx.Request) -> httpx.Response:
        form = parse_qs(request.content.decode())
        lats = [float(item) for item in form["latitude"][0].split(",")]
        lons = [float(item) for item in form["longitude"][0].split(",")]
        start = datetime.strptime(form["start_hour"][0], "%Y-%m-%dT%H:%M").replace(tzinfo=UTC)
        end = datetime.strptime(form["end_hour"][0], "%Y-%m-%dT%H:%M").replace(tzinfo=UTC)
        stamps = [start + HOUR * hour for hour in range(int((end - start) / HOUR) + 1)]
        bodies = [
            location_body(lat, lon, stamps, self.script)
            for lat, lon in zip(lats, lons, strict=True)
        ]
        return httpx.Response(200, json=bodies[0] if len(bodies) == 1 else bodies)

    @property
    def calls(self) -> int:
        """How many forecast requests were made."""
        return int(self.route.call_count)

    def requested(self) -> list[tuple[float, float]]:
        """Every ``(lat, lon)`` asked for, over all calls, in order."""
        points: list[tuple[float, float]] = []
        for call in self.route.calls:
            form = parse_qs(call.request.content.decode())
            points.extend(
                zip(
                    (float(item) for item in form["latitude"][0].split(",")),
                    (float(item) for item in form["longitude"][0].split(",")),
                    strict=True,
                )
            )
        return points


# --------------------------------------------------------------------------- requests


def next_hour(ahead: timedelta = timedelta(hours=2)) -> datetime:
    """The first full hour at least ``ahead`` from now (so every test departs in a valid window)."""
    moment = datetime.now(UTC) + ahead
    return moment.replace(minute=0, second=0, microsecond=0) + HOUR


def iso(moment: datetime) -> str:
    """RFC 3339 UTC with a ``Z``."""
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def body(
    trip: Trip,
    departure: datetime | None = None,
    *,
    load: int = 38_000,
    interval: int = 25,
    scenario: str | None = None,
) -> dict[str, Any]:
    """A valid ``POST /plans`` body for a recorded trip."""
    return {
        "origin": {"lat": trip.origin[0], "lon": trip.origin[1], "label": trip.origin_label},
        "destination": {
            "lat": trip.destination[0],
            "lon": trip.destination[1],
            "label": trip.destination_label,
        },
        "departure_time": iso(departure or next_hour()),
        "load_weight_lb": load,
        "sampling_interval_mi": interval,
        "scenario": scenario,
    }
