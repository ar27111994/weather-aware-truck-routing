"""Shared helpers of the plan and heatmap tests.

Routes are T1's *recorded* Valhalla and OSRM responses served through the real adapters and the
real routing chain. Weather is a scripted Open-Meteo upstream: it answers with the exact shape and
unit labels of the recorded sample (``openmeteo-denver-gmt-start-end-hour.json``) but its
values come from a script, so a test can place a storm exactly where and when it needs one.

The trip table, the reader of recordings and the weather helpers live in
``haulcast.providers.replay``: replay mode serves the same recordings over an HTTP transport, and
there is one source of them, not two copies. They are re-exported here for the tests.
"""

import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import parse_qs

import httpx
import respx

from haulcast.providers.replay.catalog import ReplayCatalog
from haulcast.providers.replay.trips import (
    CHICAGO_DENVER,
    LA_PHOENIX,
    NEWARK_JERSEY_CITY,
    SLC_DENVER,
    TRIPS,
    Trip,
)
from haulcast.providers.replay.weather import (
    HOUR,
    Script,
    Values,
    WeatherSample,
    benign,
    forecast_response,
    recorded_week,
)

__all__ = [
    "CHICAGO_DENVER",
    "FIXTURES",
    "HOUR",
    "LA_PHOENIX",
    "NEWARK_JERSEY_CITY",
    "OPEN_METEO_URL",
    "OSRM_URL",
    "PLANS",
    "SLC_DENVER",
    "TRIPS",
    "VALHALLA_URL",
    "ApiResponse",
    "Script",
    "Trip",
    "Values",
    "WeatherUpstream",
    "benign",
    "body",
    "calm",
    "iso",
    "mock_routing",
    "next_hour",
    "recorded",
    "weather_response",
]

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "providers"
VALHALLA_URL = "https://valhalla1.openstreetmap.de/route"
OSRM_URL = "https://router.project-osrm.org/route/v1/driving/"
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
PLANS = "/api/v1/plans"

CATALOG = ReplayCatalog(FIXTURES)
SAMPLE = WeatherSample.load(CATALOG)


class ApiResponse(Protocol):
    """What the tests read from a Django test-client response."""

    @property
    def status_code(self) -> int: ...

    @property
    def content(self) -> bytes: ...

    def json(self) -> dict[str, Any]: ...

    def __getitem__(self, header: str) -> str: ...


def recorded(kind: str, name: str) -> dict[str, Any]:
    """A recorded provider response from ``tests/fixtures/providers/<kind>``."""
    return CATALOG.recorded(kind, name)


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

calm = recorded_week(SAMPLE)
"""The recorded Denver week, replayed cyclically: real, mild, and the same everywhere."""


def weather_response(request: httpx.Request, script: Script = calm) -> httpx.Response:
    """Answer one Open-Meteo forecast request (a form POST) with the values of ``script``."""
    return forecast_response(request, script, SAMPLE)


class WeatherUpstream:
    """A scripted Open-Meteo: records which lattice points each call asked for."""

    def __init__(self, router: respx.MockRouter, script: Script = calm) -> None:
        self.script = script
        self.route = router.post(OPEN_METEO_URL).mock(side_effect=self._respond)

    def _respond(self, request: httpx.Request) -> httpx.Response:
        return weather_response(request, self.script)

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
