"""The production wiring: every collaborator is built from constants and settings, once."""

import json
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import httpx
import pytest
import respx
from django.db import connection
from pytest_django import Settings

from haulcast.problems import ProblemError
from haulcast.providers.routing.base import NoRouteFoundError
from haulcast.providers.weather.base import HourWindow, LatticePoint
from haulcast.services.container import (
    geocoding_service,
    routing_chain,
    rules_document,
    scenario_catalog,
    weather_service,
)
from haulcast.services.rules import load_rules_document
from haulcast.store.models import UpstreamBudget, WeatherCache

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "providers"
VALHALLA = "https://valhalla1.openstreetmap.de/route"
OSRM = "https://router.project-osrm.org/route/v1/driving/"
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
OPEN_METEO_GEOCODING = "https://geocoding-api.open-meteo.com/v1/search"
PHOTON = "https://photon.komoot.io/api"
SALT_LAKE = (-111.891, 40.7608)
DENVER = (-104.9903, 39.7392)
ATLANTA = (-84.388, 33.749)


@pytest.fixture(autouse=True)
def _fresh_wiring() -> Iterator[None]:
    """Each accessor caches per process: every test builds its own."""
    accessors = (
        rules_document,
        scenario_catalog,
        geocoding_service,
        routing_chain,
        weather_service,
    )
    for accessor in accessors:
        accessor.cache_clear()
    yield
    for accessor in accessors:
        accessor.cache_clear()


@pytest.fixture
def upstream() -> Iterator[respx.MockRouter]:
    """Intercept every outbound request: anything not routed explicitly fails the test."""
    with respx.mock(assert_all_called=False) as router:
        yield router


def _find(document: object, key: str) -> object:
    """Find the first value stored under ``key`` anywhere in a decoded JSON document."""
    if isinstance(document, dict):
        if key in document:
            return document[key]
        for value in document.values():
            found = _find(value, key)
            if found is not None:
                return found
    if isinstance(document, list):
        for item in document:
            found = _find(item, key)
            if found is not None:
                return found
    return None


# --------------------------------------------------------------------------- documents


def test_documents_are_loaded_once_per_process() -> None:
    assert rules_document() is rules_document()
    assert scenario_catalog() is scenario_catalog()
    assert rules_document() == load_rules_document()


def test_every_accessor_returns_one_shared_instance() -> None:
    assert geocoding_service() is geocoding_service()
    assert routing_chain() is routing_chain()
    assert weather_service() is weather_service()


# --------------------------------------------------------------------------- routing


def test_the_routing_chain_identifies_itself_and_uses_the_configured_truck_speed(
    upstream: respx.MockRouter, settings: Settings
) -> None:
    settings.HAULCAST_TRUCK_TOP_SPEED_KPH = 97.0
    valhalla = upstream.post(VALHALLA).mock(
        return_value=httpx.Response(
            400, content=(FIXTURES / "routing" / "valhalla-error-no-path.json").read_bytes()
        )
    )
    osrm = upstream.get(url__startswith=OSRM).mock(
        return_value=httpx.Response(
            200, content=(FIXTURES / "routing" / "osrm-error-no-route.json").read_bytes()
        )
    )

    with pytest.raises(NoRouteFoundError):
        routing_chain().route(SALT_LAKE, DENVER, load_weight_lb=38_000)

    request = valhalla.calls.last.request
    assert request.headers["X-Client-Id"] == "haulcast"
    assert request.headers["User-Agent"].startswith("Haulcast/")
    body = json.loads(request.content)
    assert body["costing"] == "truck"
    assert _find(body, "top_speed") == 97.0
    assert osrm.call_count == 1
    assert "X-Client-Id" not in osrm.calls.last.request.headers
    assert osrm.calls.last.request.headers["User-Agent"].startswith("Haulcast/")


def test_a_trip_beyond_valhallas_range_goes_straight_to_the_car_router(
    upstream: respx.MockRouter,
) -> None:
    valhalla = upstream.post(VALHALLA).mock(return_value=httpx.Response(500))
    osrm = upstream.get(url__startswith=OSRM).mock(
        return_value=httpx.Response(
            200, content=(FIXTURES / "routing" / "osrm-error-no-route.json").read_bytes()
        )
    )

    with pytest.raises(NoRouteFoundError):
        routing_chain().route(SALT_LAKE, ATLANTA, load_weight_lb=38_000)

    assert valhalla.call_count == 0
    assert osrm.call_count == 1


# --------------------------------------------------------------------------- weather


@pytest.mark.django_db
def test_the_weather_service_spends_budget_then_calls_open_meteo_and_caches_the_answer(
    upstream: respx.MockRouter,
) -> None:
    recorded = (FIXTURES / "weather" / "openmeteo-denver-gmt-start-end-hour.json").read_bytes()
    forecast = upstream.post(OPEN_METEO).mock(return_value=httpx.Response(200, content=recorded))
    point = LatticePoint(397, -1050)
    window = HourWindow(datetime(2026, 10, 20, 14, tzinfo=UTC), 49)

    first = weather_service().hourly([point], window)[point]
    second = weather_service().hourly([point], window)[point]

    assert first.hours == 49
    assert first == second
    assert forecast.call_count == 1
    form: dict[str, Any] = parse_qs(forecast.calls.last.request.content.decode())
    assert form["latitude"] == ["39.7"]
    assert form["longitude"] == ["-105.0"]
    assert form["start_hour"] == ["2026-10-20T14:00"]
    assert form["end_hour"] == ["2026-10-22T14:00"]
    assert form["timezone"] == ["GMT"]
    assert form["wind_speed_unit"] == ["mph"]
    assert form["precipitation_unit"] == ["inch"]
    assert form["temperature_unit"] == ["fahrenheit"]
    assert forecast.calls.last.request.headers["User-Agent"].startswith("Haulcast/")
    assert WeatherCache.objects.count() == 1
    assert set(UpstreamBudget.objects.values_list("key", flat=True)) == {
        "openmeteo:minute",
        "openmeteo:hour",
        "openmeteo:day",
    }


@pytest.mark.django_db
def test_every_routing_attempt_spends_the_shared_budget_retries_included(
    upstream: respx.MockRouter,
) -> None:
    recorded = (FIXTURES / "routing" / "valhalla-slc-den-truck-alt2.json").read_bytes()
    upstream.post(VALHALLA).mock(
        side_effect=[httpx.Response(503), httpx.Response(200, content=recorded)]
    )
    charged: list[str] = []

    def record(execute: Callable[..., object], statement: str, *rest: object) -> object:
        if "upstream_budget_take" in statement:
            params = rest[0]
            assert isinstance(params, list)
            charged.append(str(params[0]))
        return execute(statement, *rest)

    with connection.execute_wrapper(record):
        result = routing_chain().route(SALT_LAKE, DENVER, load_weight_lb=38_000)

    assert len(result.routes) == 3
    # Two attempts reached the server (the first answered 503), and each one paid its call.
    assert charged == ["routing:minute", "routing:minute"]


@pytest.mark.django_db
def test_every_weather_attempt_spends_the_shared_budget_retries_included(
    upstream: respx.MockRouter,
) -> None:
    recorded = (FIXTURES / "weather" / "openmeteo-denver-gmt-start-end-hour.json").read_bytes()
    upstream.post(OPEN_METEO).mock(
        side_effect=[httpx.Response(503), httpx.Response(200, content=recorded)]
    )
    charged: list[tuple[str, int]] = []

    def record(execute: Callable[..., object], statement: str, *rest: object) -> object:
        if "upstream_budget_take" in statement:
            params = rest[0]
            assert isinstance(params, list)
            charged.append((str(params[0]), int(params[4])))
        return execute(statement, *rest)

    point = LatticePoint(397, -1050)
    window = HourWindow(datetime(2026, 10, 20, 14, tzinfo=UTC), 49)
    with connection.execute_wrapper(record):
        weather_service().hourly([point], window)

    # Two attempts reached the server (the first answered 503) and each paid for its one location.
    assert [item for item in charged if item[0] == "openmeteo:minute"] == [
        ("openmeteo:minute", 1),
        ("openmeteo:minute", 1),
    ]


# --------------------------------------------------------------------------- geocoding


def _geocoding_fixture(name: str) -> bytes:
    return (FIXTURES / "geocoding" / name).read_bytes()


@pytest.mark.django_db
def test_geocoding_asks_the_fast_city_index_first_and_leaves_photon_alone_when_it_answers(
    upstream: respx.MockRouter,
) -> None:
    # T14 measured Photon at 6.7 s uncached and Open-Meteo at 1.0-1.4 s, against a 3.5 s budget.
    cities = upstream.get(url__startswith=OPEN_METEO_GEOCODING).mock(
        return_value=httpx.Response(200, content=_geocoding_fixture("omgeo-denver.json"))
    )
    streets = upstream.get(url__startswith=PHOTON).mock(
        return_value=httpx.Response(200, content=_geocoding_fixture("photon-denver.json"))
    )

    found = geocoding_service().search("denver", 5)

    assert found.candidates[0].id.startswith("geonames:")
    assert (cities.call_count, streets.call_count) == (1, 0)


@pytest.mark.django_db
def test_an_empty_city_answer_is_escalated_to_the_street_level_index(
    upstream: respx.MockRouter,
) -> None:
    cities = upstream.get(url__startswith=OPEN_METEO_GEOCODING).mock(
        return_value=httpx.Response(200, content=_geocoding_fixture("omgeo-address.json"))
    )
    streets = upstream.get(url__startswith=PHOTON).mock(
        return_value=httpx.Response(200, content=_geocoding_fixture("photon-address.json"))
    )

    found = geocoding_service().search("1600 pennsylvania ave nw washington", 5)

    assert found.candidates[0].id.startswith("osm:")
    assert (cities.call_count, streets.call_count) == (1, 1)


@pytest.mark.django_db
def test_each_geocoding_provider_gets_one_bounded_attempt_and_no_retries(
    upstream: respx.MockRouter,
) -> None:
    # The other provider is the retry: a second attempt on a slow one would eat its budget.
    cities = upstream.get(url__startswith=OPEN_METEO_GEOCODING).mock(
        side_effect=httpx.ConnectTimeout("slow")
    )
    streets = upstream.get(url__startswith=PHOTON).mock(side_effect=httpx.ConnectTimeout("slow"))

    with pytest.raises(ProblemError) as raised:
        geocoding_service().search("denver", 5)

    assert raised.value.code == "geocoding_unavailable"
    assert (cities.call_count, streets.call_count) == (1, 1)
