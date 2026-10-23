"""Replay mode through the API: every recorded trip and scenario, the geocoder, the frozen clock.

The Django test client runs the real endpoints, services, adapters and Postgres store; only the HTTP
transport of the provider clients is the replay transport. Every test of this module runs with the
network forbidden: a socket or a name lookup fails the test, in its body or at its teardown.

Run it with ``-s`` to print the table of trip x scenario (status, routes, recommended route and the
key that decided it) that the pull request of the replay card reproduces.
"""

import json
import socket
import sys
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any, NoReturn

import pytest
from django.test import Client
from pytest_django import Settings

import haulcast.api.ratelimit as ratelimit_middleware
import haulcast.services.plan_service as plan_service_module
from haulcast.config.env import ProviderMode
from haulcast.providers.replay.geocoding import OPEN_METEO_RECORDINGS, PHOTON_RECORDINGS
from haulcast.providers.replay.trips import (
    CHICAGO_DENVER,
    LA_PHOENIX,
    NEWARK_JERSEY_CITY,
    SLC_DENVER,
    TRIPS,
    Place,
    Trip,
    gazetteer,
)
from haulcast.services import container
from haulcast.services.ratelimit import (
    BucketStatus,
    RateDecision,
    RateLimitService,
    RateRule,
)
from haulcast.store.models import GeocodeCache, Plan, RouteCache, WeatherCache
from tests.plans.fakes import FIXED_NOW
from tests.plans.support import FIXTURES, PLANS, ApiResponse, body

pytestmark = pytest.mark.django_db

GEOCODE = "/api/v1/geocode"
DEPARTURE = datetime(2026, 10, 20, 16, 0, tzinfo=UTC)
"""Two hours and twenty minutes after the frozen clock: inside the accepted departure window."""
SCENARIOS = (None, "calm", "storm-on-fastest", "high-wind-corridor", "gulf-downpour")
HEAVY_LOAD = 38_000
LIGHT_LOAD = 25_000
TRIP_COUNT = len(TRIPS)
CASES = [(trip, scenario, HEAVY_LOAD) for trip in TRIPS for scenario in SCENARIOS] + [
    (trip, "high-wind-corridor", LIGHT_LOAD) for trip in TRIPS
]
ACCESSORS = (
    container.geocoding_service,
    container.routing_chain,
    container.routing_service,
    container.weather_service,
    container.plan_service,
    container.heatmap_service,
)
TABLE: list[str] = []
NO_SAFE_ROUTE = {
    (NEWARK_JERSEY_CITY.name, "high-wind-corridor", HEAVY_LOAD),
    (LA_PHOENIX.name, "high-wind-corridor", HEAVY_LOAD),
}
"""The catalog cases whose recommended route crosses No Travel miles: all the others are ok."""


class Permissive:
    """A limiter that never refuses: the limits themselves are tested elsewhere."""

    def take(self, client_key: str, rule: RateRule) -> RateDecision:
        del client_key
        return RateDecision(
            allowed=True,
            retry_after_s=0.0,
            statuses=tuple(BucketStatus(policy, policy.limit, 0.0) for policy in rule.policies),
        )


@pytest.fixture
def network_attempts(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Forbid sockets and name lookups; the list names every attempt (the database uses libpq)."""
    attempts: list[str] = []

    def refuse(*_args: object, **_kwargs: object) -> NoReturn:
        attempts.append("socket")
        raise AssertionError("a real network call was attempted")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "getaddrinfo", refuse)
    return attempts


def _reset_wiring() -> None:
    """Fresh services and empty cache tables: the next request recomputes from the transport."""
    for accessor in ACCESSORS:
        accessor.cache_clear()
    for model in (Plan, RouteCache, WeatherCache, GeocodeCache):
        model.objects.all().delete()


@pytest.fixture(autouse=True)
def _replay_api(
    settings: Settings, monkeypatch: pytest.MonkeyPatch, network_attempts: list[str]
) -> Iterator[None]:
    """Replay mode on the recorded fixtures at the frozen instant, no rate limit, no network."""
    settings.HAULCAST_PROVIDER_MODE = ProviderMode.REPLAY
    settings.HAULCAST_REPLAY_DIR = FIXTURES
    settings.HAULCAST_REPLAY_NOW = FIXED_NOW
    permissive = RateLimitService(Permissive(), Permissive())
    monkeypatch.setattr(ratelimit_middleware, "rate_limit_service", lambda: permissive)
    monkeypatch.setattr(plan_service_module, "REQUEST_BUDGET_S", 300.0)
    _reset_wiring()
    yield
    _reset_wiring()
    assert network_attempts == []


@pytest.fixture(scope="module", autouse=True)
def _print_the_table() -> Iterator[None]:
    yield
    if TABLE:
        header = (
            "| trip | scenario | load lb | status | routes | recommended | decided by | "
            "no travel mi | routes crossing |"
        )
        rows = [header, "| --- | --- | ---: | --- | ---: | --- | --- | ---: | ---: |", *TABLE]
        sys.stdout.write("\n".join(rows) + "\n")


def post(client: Client, payload: dict[str, Any]) -> ApiResponse:
    return client.post(PLANS, data=payload, content_type="application/json")


def expected_status(trip: Trip, scenario: str | None, load: int) -> str:
    """The recommended status of a catalog case: only the two trips below ever have no safe route.

    ``high-wind-corridor`` puts a band of No Travel wind (for loads over 30,000 lb) across the
    middle of the trip. On the two long trips an alternative route bypasses it, so the recommended
    route crosses no No Travel mile and the status is ok. On the short trip every route crosses the
    band and the one-route trip has nowhere to go: no_safe_route (domain/scoring.py).
    """
    return "no_safe_route" if (trip.name, scenario, load) in NO_SAFE_ROUTE else "ok"


# --------------------------------------------------------------------------- plans and heatmaps


@pytest.mark.parametrize(
    ("trip", "scenario", "load"),
    CASES,
    ids=[f"{trip.name}-{scenario or 'recorded-weather'}-{load}" for trip, scenario, load in CASES],
)
def test_every_recorded_trip_and_scenario_makes_a_plan_and_a_heatmap(
    client: Client, trip: Trip, scenario: str | None, load: int
) -> None:
    created = post(client, body(trip, DEPARTURE, load=load, scenario=scenario))

    assert created.status_code == 201, created.content
    plan = created.json()
    routes = plan["routes"]
    recommendation = plan["recommendation"]
    assert 1 <= len(routes) <= 3
    assert recommendation["route_id"] in {route["route_id"] for route in routes}
    chosen = next(route for route in routes if route["route_id"] == recommendation["route_id"])
    no_travel = chosen["stats"]["miles_by_level"]["no_travel"]
    crossing = sum(route["stats"]["miles_by_level"]["no_travel"] > 0 for route in routes)
    assert recommendation["status"] == ("no_safe_route" if no_travel > 0 else "ok")
    assert recommendation["status"] == expected_status(trip, scenario, load)
    heatmap = client.get(f"{PLANS}/{plan['plan_id']}/heatmap")
    assert heatmap.status_code == 200
    document = heatmap.json()
    assert document["frame_count"] == 49
    assert len(document["fields"]["risk"]) == 49 * len(document["cells"])
    TABLE.append(
        f"| {trip.name} | {scenario or 'none'} | {load:,} | {recommendation['status']} | "
        f"{len(routes)} | {chosen['route_id']} ({chosen['label']}) | "
        f"{recommendation['decided_by']} | {no_travel:g} | {crossing} |"
    )


def test_an_unrecorded_pair_has_no_route(client: Client) -> None:
    unrecorded = Trip(
        "la-chi",
        LA_PHOENIX.origin,
        CHICAGO_DENVER.origin,
        LA_PHOENIX.origin_label,
        CHICAGO_DENVER.origin_label,
        "",
        "",
    )

    response = post(client, body(unrecorded, DEPARTURE))

    assert response.status_code == 422
    assert response.json()["code"] == "no_route_found"


def test_the_wall_clock_of_a_plan_is_the_frozen_instant(client: Client) -> None:
    plan = post(client, body(SLC_DENVER, DEPARTURE, scenario="calm")).json()

    assert datetime.fromisoformat(plan["created_at"]) == FIXED_NOW
    assert datetime.fromisoformat(plan["expires_at"]) == FIXED_NOW + timedelta(days=7)
    heatmap = client.get(f"{PLANS}/{plan['plan_id']}/heatmap").json()
    assert datetime.fromisoformat(heatmap["generated_at"]) == FIXED_NOW


def test_an_identical_request_returns_the_stored_plan_because_the_clock_never_moves(
    client: Client,
) -> None:
    first = post(client, body(SLC_DENVER, DEPARTURE, scenario="calm"))
    second = post(client, body(SLC_DENVER, DEPARTURE, scenario="calm"))

    assert (first.status_code, second.status_code) == (201, 200)
    assert first.json()["plan_id"] == second.json()["plan_id"]


@pytest.mark.parametrize(
    "departure",
    [
        pytest.param(FIXED_NOW - timedelta(hours=1), id="before-the-frozen-now"),
        pytest.param(DEPARTURE + timedelta(days=6), id="beyond-five-days-of-the-frozen-now"),
    ],
)
def test_the_departure_window_is_measured_from_the_frozen_clock(
    client: Client, departure: datetime
) -> None:
    response = post(client, body(SLC_DENVER, departure))

    assert response.status_code == 422
    assert response.json()["code"] == "departure_out_of_range"


# --------------------------------------------------------------------------- determinism


def _journey(client: Client, scenario: str | None) -> tuple[str, str]:
    """A plan and its heatmap as sorted JSON text, the plan id masked."""
    plan = post(client, body(SLC_DENVER, DEPARTURE, scenario=scenario)).json()
    plan_id = plan["plan_id"]
    heatmap = client.get(f"{PLANS}/{plan_id}/heatmap").json()
    texts = (json.dumps(document, sort_keys=True) for document in (plan, heatmap))
    first, second = (text.replace(plan_id, "<plan_id>") for text in texts)
    return first, second


@pytest.mark.parametrize("scenario", [None, "storm-on-fastest"])
def test_the_same_plan_made_twice_is_the_same_apart_from_its_id(
    client: Client, scenario: str | None
) -> None:
    first = _journey(client, scenario)
    _reset_wiring()
    second = _journey(client, scenario)

    assert first == second
    assert "<plan_id>" in first[0]


# --------------------------------------------------------------------------- geocoding

RECORDED_FIRST_NAMES = {
    "denver": "Denver",
    "denver, co": "Denver",
    "salt lake": "Salt Lake City",
    "newark": "Newark",
    "springfield": "Springfield",
    "den": "Denver",
    "united states": "United States",
    "denv": "Denver",
    "chicago, il": "Chicago",
}
"""The first result of the recorded queries whose answer has a city to name."""
EMPTY_RECORDED = ("1600 pennsylvania ave nw",)


def _geocode(client: Client, query: str) -> dict[str, Any]:
    response = client.get(GEOCODE, {"q": query})
    assert response.status_code == 200, response.content
    document: dict[str, Any] = response.json()
    return document


@pytest.mark.parametrize(("query", "first"), sorted(RECORDED_FIRST_NAMES.items()))
def test_a_recorded_query_answers_with_the_city_its_recording_names_first(
    client: Client, query: str, first: str
) -> None:
    assert _geocode(client, query)["results"][0]["name"] == first


@pytest.mark.parametrize("query", EMPTY_RECORDED)
def test_a_recorded_address_has_no_city_to_offer(client: Client, query: str) -> None:
    assert _geocode(client, query)["results"] == []


def test_every_recorded_query_is_answered() -> None:
    covered = set(RECORDED_FIRST_NAMES) | set(EMPTY_RECORDED)
    recorded = set(OPEN_METEO_RECORDINGS) | set(PHOTON_RECORDINGS)

    assert recorded - covered == {"d", "1600 pennsylvania ave nw washington"}
    assert covered <= recorded


def test_a_recorded_address_query_reaches_photon_when_the_city_index_has_nothing(
    client: Client,
) -> None:
    results = _geocode(client, "1600 pennsylvania ave nw washington")["results"]

    assert results
    assert results[0]["id"].startswith("osm:")


@pytest.mark.parametrize("place", gazetteer(), ids=lambda place: place.name)
def test_every_trip_city_comes_first_when_typed_by_its_first_three_letters(
    client: Client, place: Place
) -> None:
    results = _geocode(client, place.name[:3])["results"]

    assert results[0]["name"] == place.name


def test_a_geocoded_trip_city_plans_a_trip(client: Client) -> None:
    """Typing the endpoints into the search box and planning with what comes back works."""
    origin = _geocode(client, "salt lake city")["results"][0]
    destination = _geocode(client, "den")["results"][0]
    payload = body(SLC_DENVER, DEPARTURE, scenario="calm")
    payload["origin"] = {"lat": origin["lat"], "lon": origin["lon"], "label": origin["label"]}
    payload["destination"] = {
        "lat": destination["lat"],
        "lon": destination["lon"],
        "label": destination["label"],
    }

    response = post(client, payload)

    assert response.status_code == 201, response.content
    assert len(response.json()["routes"]) >= 1
