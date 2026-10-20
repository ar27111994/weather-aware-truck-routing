"""``POST /api/v1/plans`` end to end: recorded routes, scripted weather, real Postgres."""

import math
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from typing import Any

import pytest
import respx
from django.test import Client

from haulcast.services.plan_ids import PLAN_ID_PATTERN
from haulcast.store.models import Plan
from tests.plans.support import (
    CHICAGO_DENVER,
    NEWARK_JERSEY_CITY,
    PLANS,
    SLC_DENVER,
    ApiResponse,
    Script,
    Values,
    WeatherUpstream,
    benign,
    body,
    calm,
    iso,
    mock_routing,
    next_hour,
)

pytestmark = pytest.mark.django_db

HOUR = timedelta(hours=1)


def post(client: Client, payload: dict[str, Any]) -> ApiResponse:
    return client.post(PLANS, data=payload, content_type="application/json")


def parse(stamp: str) -> datetime:
    return datetime.fromisoformat(stamp)


def check_route(route: dict[str, Any], departure: datetime, interval: int) -> None:
    """The structural promises of API-CONTRACT for one route, independent of any weather."""
    coords, cum_mi, cum_s = (
        route["geometry"]["coordinates"],
        route["cumulative_mi"],
        route["cumulative_s"],
    )
    vertices = len(coords)
    length = cum_mi[-1]
    assert route["geometry"]["type"] == "LineString"
    assert vertices >= 2
    assert len(cum_mi) == len(cum_s) == vertices
    assert (cum_mi[0], cum_s[0]) == (0.0, 0)
    assert all(b >= a for a, b in pairwise(cum_mi))
    assert all(b >= a for a, b in pairwise(cum_s))
    assert length == pytest.approx(route["distance_mi"], abs=0.06)
    assert cum_s[-1] == route["duration_s"]
    assert parse(route["departure_time"]) == departure
    assert parse(route["arrival_time"]) == departure + timedelta(seconds=route["duration_s"])

    checkpoints = route["checkpoints"]
    assert len(checkpoints) == math.ceil((length - 0.01) / interval) + 1
    assert [cp["index"] for cp in checkpoints] == list(range(len(checkpoints)))
    assert checkpoints[0]["distance_mi"] == 0.0
    assert checkpoints[-1]["distance_mi"] == pytest.approx(length, abs=0.06)
    for position, cp in enumerate(checkpoints[:-1]):
        assert cp["distance_mi"] == pytest.approx(position * interval, abs=0.06)
    assert parse(checkpoints[0]["eta"]) == departure
    assert parse(checkpoints[-1]["eta"]) == parse(route["arrival_time"])
    etas = [parse(cp["eta"]) for cp in checkpoints]
    assert etas == sorted(etas)
    owned = sum(cp["owned_mi"] for cp in checkpoints)
    assert owned == pytest.approx(length, abs=0.005 * len(checkpoints) + 0.01)
    assert checkpoints[0]["coord_start"] == 0
    assert checkpoints[-1]["coord_end"] == vertices - 1
    for cp, following in pairwise(checkpoints):
        assert following["coord_start"] == cp["coord_end"]
    assert all(0 <= cp["coord_start"] <= cp["coord_end"] < vertices for cp in checkpoints)
    for cp in checkpoints:
        assert cp["timezone"]
        assert cp["weather"]["valid_time"] == cp["eta"]
        assert set(cp["risk"]["factors"]) == {"wind", "rain", "snow"}

    stats = route["stats"]
    accounted = sum(stats["miles_by_level"].values()) + stats["unknown_mi"]
    assert accounted == pytest.approx(length, abs=0.35)
    assert set(stats["miles_by_level"]) == {"low", "moderate", "high", "severe", "no_travel"}


# --------------------------------------------------------------------------- the three trip sizes


def test_a_medium_trip_returns_the_documented_plan(
    client: Client, upstream: respx.MockRouter
) -> None:
    mock_routing(upstream, SLC_DENVER)
    weather = WeatherUpstream(upstream)
    departure = next_hour()

    response = post(client, body(SLC_DENVER, departure))

    plan = response.json()
    assert response.status_code == 201
    assert response["Content-Type"] == "application/json"
    assert response["Cache-Control"] == "no-store"
    assert response["Location"] == f"/api/v1/plans/{plan['plan_id']}"
    assert PLAN_ID_PATTERN.fullmatch(plan["plan_id"])
    assert set(plan) == {
        "plan_id",
        "created_at",
        "expires_at",
        "request",
        "sources",
        "routes",
        "recommendation",
        "warnings",
    }
    assert parse(plan["expires_at"]) - parse(plan["created_at"]) == timedelta(days=7)
    assert plan["request"] == {
        "origin": {"lat": 40.7608, "lon": -111.891, "label": SLC_DENVER.origin_label},
        "destination": {"lat": 39.7392, "lon": -104.9903, "label": SLC_DENVER.destination_label},
        "departure_time": iso(departure),
        "load_weight_lb": 38_000,
        "sampling_interval_mi": 25,
        "scenario": None,
    }
    assert plan["sources"] == {
        "routing": "valhalla",
        "weather": "open-meteo",
        "weather_model": "best_match",
        "scenario": None,
        "attribution": [
            "© OpenStreetMap contributors",
            "Weather data by Open-Meteo.com (CC BY 4.0)",
        ],
    }
    routes = plan["routes"]
    assert 1 <= len(routes) <= 3
    assert [route["rank"] for route in routes] == list(range(1, len(routes) + 1))
    assert [route["recommended"] for route in routes] == [True] + [False] * (len(routes) - 1)
    assert plan["recommendation"]["route_id"] == routes[0]["route_id"]
    assert plan["recommendation"]["status"] in {"ok", "no_safe_route"}
    for route in routes:
        check_route(route, departure, interval=25)
    if len(routes) < 3:
        assert any("distinct" in warning for warning in plan["warnings"])
    assert weather.calls == 1


def test_a_long_haul_is_routed_by_osrm_and_says_so(
    client: Client, upstream: respx.MockRouter
) -> None:
    _, cars = mock_routing(upstream, CHICAGO_DENVER)
    weather = WeatherUpstream(upstream)
    departure = next_hour()

    response = post(client, body(CHICAGO_DENVER, departure))

    plan = response.json()
    assert response.status_code == 201
    assert plan["sources"]["routing"] == "osrm"
    assert any("truck restrictions" in warning for warning in plan["warnings"])
    assert cars[CHICAGO_DENVER.name].call_count == 1
    for route in plan["routes"]:
        assert 900 < route["distance_mi"] < 1_300
        check_route(route, departure, interval=25)
    asked = weather.requested()
    assert weather.calls == 1
    assert 0 < len(asked) <= 250
    assert len(set(asked)) == len(asked)


def test_a_trip_shorter_than_the_interval_has_exactly_an_origin_and_a_destination(
    client: Client, upstream: respx.MockRouter
) -> None:
    mock_routing(upstream, NEWARK_JERSEY_CITY)
    WeatherUpstream(upstream)
    departure = next_hour()

    response = post(client, body(NEWARK_JERSEY_CITY, departure, interval=50))

    assert response.status_code == 201
    for route in response.json()["routes"]:
        assert route["distance_mi"] < 50
        assert len(route["checkpoints"]) == 2
        check_route(route, departure, interval=50)


# --------------------------------------------------------------------------- R3: the forecast hour


def unique_hours(lat: float, lon: float, stamp: datetime) -> Values:  # noqa: ARG001
    """Every hour has its own numbers, the same at every place."""
    hours = int(stamp.timestamp() // 3600)
    rain = (hours % 5) * 0.011
    showers = (hours % 3) * 0.002
    return {
        "wind_speed_10m": 5 + (hours % 17) * 1.3,
        "wind_gusts_10m": 12 + (hours % 11) * 0.9,
        "rain": rain,
        "showers": showers,
        "snowfall": 0.0,
        "precipitation": rain + showers,
        "temperature_2m": 30 + (hours % 23) * 1.7,
        "weather_code": 1 + hours % 7,
    }


def expected_weather(eta: datetime) -> dict[str, float | int]:
    """The DOMAIN-CONTRACT 5 rule, written out independently of the code under test."""
    lower = eta.replace(minute=0, second=0, microsecond=0)
    upper = lower if eta == lower else lower + HOUR
    fraction = (eta - lower) / HOUR
    low, high = unique_hours(0, 0, lower), unique_hours(0, 0, upper)

    def instant(name: str) -> float:
        return float(low[name] or 0) + (float(high[name] or 0) - float(low[name] or 0)) * fraction

    nearest = lower if fraction <= 0.5 else upper
    return {
        "wind_mph": instant("wind_speed_10m"),
        "gust_mph": float(high["wind_gusts_10m"] or 0),
        "rain_in_hr": float(high["rain"] or 0) + float(high["showers"] or 0),
        "snow_in_hr": float(high["snowfall"] or 0),
        "temperature_f": instant("temperature_2m"),
        "weather_code": int(unique_hours(0, 0, nearest)["weather_code"] or 0),
    }


def test_the_forecast_hour_used_for_every_checkpoint_follows_the_eta_rule(
    client: Client, upstream: respx.MockRouter
) -> None:
    """R3: instant values interpolate between the two hours around the ETA, accumulated values
    (rain, snow, gust) come from the hour that *ends* at the ETA, the weather code from the
    nearest hour."""
    mock_routing(upstream, SLC_DENVER)
    weather = WeatherUpstream(upstream, unique_hours)
    departure = next_hour()

    plan = post(client, body(SLC_DENVER, departure, interval=10)).json()

    checked = 0
    mid_hour = 0
    for route in plan["routes"]:
        for checkpoint in route["checkpoints"]:
            eta = parse(checkpoint["eta"])
            expected = expected_weather(eta)
            actual = checkpoint["weather"]
            assert parse(actual["valid_time"]) == eta
            assert actual["wind_mph"] == pytest.approx(expected["wind_mph"], abs=0.051)
            assert actual["gust_mph"] == pytest.approx(expected["gust_mph"], abs=0.051)
            assert actual["rain_in_hr"] == pytest.approx(expected["rain_in_hr"], abs=0.0006)
            assert actual["snow_in_hr"] == expected["snow_in_hr"]
            assert actual["temperature_f"] == pytest.approx(expected["temperature_f"], abs=0.051)
            assert actual["weather_code"] == expected["weather_code"]
            checked += 1
            mid_hour += eta.minute != 0 or eta.second != 0
    assert checked >= 20
    assert mid_hour > checked // 2, "the test must exercise ETAs between the hours"
    form_start = parse(plan["request"]["departure_time"]).replace(minute=0)
    first_call = weather.route.calls[0].request.content.decode()
    assert f"start_hour={form_start.strftime('%Y-%m-%dT%H')}" in first_call.replace("%3A", ":")


def test_the_weather_window_covers_the_trip_and_the_heatmap_frames(
    client: Client, upstream: respx.MockRouter
) -> None:
    mock_routing(upstream, NEWARK_JERSEY_CITY)
    weather = WeatherUpstream(upstream)
    departure = next_hour()

    post(client, body(NEWARK_JERSEY_CITY, departure))

    form = weather.route.calls[0].request.content.decode().replace("%3A", ":").split("&")
    values = dict(item.split("=", 1) for item in form)
    start = datetime.strptime(values["start_hour"], "%Y-%m-%dT%H:%M").replace(tzinfo=UTC)
    end = datetime.strptime(values["end_hour"], "%Y-%m-%dT%H:%M").replace(tzinfo=UTC)
    assert start == departure
    assert end - start == 48 * HOUR


# --------------------------------------------------------------------------- idempotency


def test_an_identical_request_returns_the_stored_plan_without_any_upstream_call(
    client: Client, upstream: respx.MockRouter
) -> None:
    truck, _ = mock_routing(upstream, SLC_DENVER)
    weather = WeatherUpstream(upstream)
    request = body(SLC_DENVER)

    first = post(client, request)
    routing_calls, weather_calls = truck.call_count, weather.calls
    second = post(client, request)

    assert (first.status_code, second.status_code) == (201, 200)
    assert second.json() == first.json()
    assert second["Location"] == first["Location"]
    assert (truck.call_count, weather.calls) == (routing_calls, weather_calls)
    assert Plan.objects.count() == 1


def test_labels_and_seconds_do_not_make_a_request_different(
    client: Client, upstream: respx.MockRouter
) -> None:
    mock_routing(upstream, SLC_DENVER)
    WeatherUpstream(upstream)
    departure = next_hour()
    first = post(client, body(SLC_DENVER, departure))
    again = body(SLC_DENVER, departure)
    again["origin"]["label"] = "SLC"
    again["departure_time"] = iso(departure + timedelta(seconds=42))

    second = post(client, again)

    assert (first.status_code, second.status_code) == (201, 200)
    assert second.json()["plan_id"] == first.json()["plan_id"]


@pytest.mark.parametrize(
    "change",
    [
        {"load_weight_lb": 30_000},
        {"sampling_interval_mi": 50},
        {"departure_time": "minute"},
    ],
    ids=["load", "interval", "departure-minute"],
)
def test_a_request_that_differs_in_what_matters_is_a_new_plan(
    client: Client, upstream: respx.MockRouter, change: dict[str, Any]
) -> None:
    mock_routing(upstream, SLC_DENVER)
    WeatherUpstream(upstream)
    departure = next_hour()
    first = post(client, body(SLC_DENVER, departure))
    other = body(SLC_DENVER, departure)
    if change.get("departure_time") == "minute":
        other["departure_time"] = iso(departure + timedelta(minutes=1))
    else:
        other.update(change)

    second = post(client, other)

    assert (first.status_code, second.status_code) == (201, 201)
    assert second.json()["plan_id"] != first.json()["plan_id"]
    assert Plan.objects.count() == 2


def test_the_route_cache_serves_the_same_trip_at_another_departure(
    client: Client, upstream: respx.MockRouter
) -> None:
    truck, _ = mock_routing(upstream, SLC_DENVER)
    WeatherUpstream(upstream)
    first = post(client, body(SLC_DENVER, next_hour()))
    routing_calls = truck.call_count

    second = post(client, body(SLC_DENVER, next_hour() + HOUR))

    assert (first.status_code, second.status_code) == (201, 201)
    assert truck.call_count == routing_calls


# --------------------------------------------------------------------------- partial weather


def no_weather_east_of(longitude: float) -> Script:
    """Calm weather, except that every value east of ``longitude`` is missing."""

    def script(lat: float, lon: float, stamp: datetime) -> Values:
        values = calm(lat, lon, stamp)
        if lon > longitude:
            return dict.fromkeys(values)
        return values

    return script


def test_missing_weather_becomes_unknown_checkpoints_a_warning_and_no_crash(
    client: Client, upstream: respx.MockRouter
) -> None:
    mock_routing(upstream, SLC_DENVER)
    weather = WeatherUpstream(upstream, benign)
    baseline = post(client, body(SLC_DENVER, next_hour())).json()
    weather.script = no_weather_east_of(-108.0)
    later = next_hour() + HOUR

    response = post(client, body(SLC_DENVER, later))

    plan = response.json()
    assert response.status_code == 201
    unknown_total = 0
    for route in plan["routes"]:
        unknown = [cp for cp in route["checkpoints"] if cp["risk"]["level"] is None]
        known = [cp for cp in route["checkpoints"] if cp["risk"]["level"] is not None]
        assert unknown, "the eastern half has no weather"
        assert known, "the western half does"
        assert all(cp["weather"]["wind_mph"] is None for cp in unknown)
        assert all(cp["lon"] > -108.0 for cp in unknown)
        assert route["stats"]["unknown_mi"] == pytest.approx(
            sum(cp["owned_mi"] for cp in unknown), abs=0.1 * len(unknown)
        )
        unknown_total += len(unknown)
    assert unknown_total
    assert any("weather is missing" in warning for warning in plan["warnings"])
    assert [route["route_id"] for route in plan["routes"]] == [
        route["route_id"] for route in baseline["routes"]
    ]
