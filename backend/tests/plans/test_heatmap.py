"""``GET /api/v1/plans/{plan_id}/heatmap``: grid geometry (D-22), frames, storage, failures."""

import math
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
import respx
from django.test import Client
from django.utils import timezone

import haulcast.services.heatmap_service as heatmap_module
from haulcast.problems import ProblemError
from haulcast.providers.errors import ProviderRateLimitedError
from haulcast.services.container import scenario_catalog
from haulcast.services.single_flight import lease_key
from haulcast.store.models import Plan, SingleFlightLease, UpstreamBudget
from tests.plans.fakes import (
    ScriptedRouting,
    ScriptedWeather,
    build_services,
    request_for,
    result_of,
    straight_route,
)
from tests.plans.support import (
    SLC_DENVER,
    ApiResponse,
    Values,
    WeatherUpstream,
    benign,
    body,
    calm,
    mock_routing,
    next_hour,
)
from tests.plans.test_create_plan import post

pytestmark = pytest.mark.django_db

HOUR = timedelta(hours=1)


def heatmap(client: Client, plan_id: str) -> ApiResponse:
    return client.get(f"/api/v1/plans/{plan_id}/heatmap")


def lattice_of(lat: float, lon: float) -> tuple[int, int]:
    """The 0.1 degree lattice point of a coordinate, by plain arithmetic."""
    return math.floor(lat * 10 + 0.5), math.floor(lon * 10 + 0.5)


def cell_centre(grid: dict[str, Any], index: int) -> tuple[float, float]:
    """``(lat, lon)`` of a cell centre by the D-22 formulas, from the response's own numbers."""
    row, col = divmod(index, grid["cols"])
    return (
        grid["lat0"] + (row + 0.5) * grid["dlat"],
        grid["lon0"] + (col + 0.5) * grid["dlon"],
    )


def distinct_per_place(lat: float, lon: float, stamp: datetime) -> Values:
    """Wind and gust that differ from lattice point to lattice point, the same every hour."""
    lat_e1, lon_e1 = lattice_of(lat, lon)
    return {
        **benign(lat, lon, stamp),
        "wind_speed_10m": 3 + ((lat_e1 * 31 + lon_e1 * 17) % 400) / 10,
        "wind_gusts_10m": 8 + ((lat_e1 * 13 + lon_e1 * 29) % 500) / 10,
    }


@pytest.fixture
def made(
    client: Client, upstream: respx.MockRouter
) -> tuple[dict[str, Any], WeatherUpstream, datetime]:
    """A plan SLC to Denver over distinct per-place weather; its weather upstream and departure."""
    mock_routing(upstream, SLC_DENVER)
    weather = WeatherUpstream(upstream, distinct_per_place)
    departure = next_hour()
    plan = post(client, body(SLC_DENVER, departure)).json()
    return plan, weather, departure


# --------------------------------------------------------------------------- shape


def test_the_heatmap_has_49_hourly_frames_over_a_corridor_grid(
    client: Client, made: tuple[dict[str, Any], WeatherUpstream, datetime]
) -> None:
    plan, _, departure = made

    response = heatmap(client, plan["plan_id"])

    document = response.json()
    cells, fields = document["cells"], document["fields"]
    assert response.status_code == 200
    assert set(document) == {
        "plan_id",
        "start_time",
        "frame_count",
        "step_minutes",
        "grid",
        "cells",
        "fields",
        "load_weight_lb",
        "sources",
        "generated_at",
    }
    assert document["plan_id"] == plan["plan_id"]
    assert document["start_time"] == departure.strftime("%Y-%m-%dT%H:%M:%SZ")
    assert (document["frame_count"], document["step_minutes"]) == (49, 60)
    assert document["load_weight_lb"] == 38_000
    assert document["sources"] == plan["sources"]
    assert set(document["grid"]) == {"lat0", "lon0", "dlat", "dlon", "rows", "cols"}
    assert 0 < len(cells) <= 200
    assert cells == sorted(set(cells))
    assert cells[-1] < document["grid"]["rows"] * document["grid"]["cols"]
    assert set(fields) == {"risk", "wind_mph", "gust_mph", "rain_in_hr", "snow_in_hr"}
    assert all(len(values) == 49 * len(cells) for values in fields.values())
    assert set(fields["risk"]) <= {-1, 0, 1, 2, 3, 4}
    assert response["Content-Type"] == "application/json"
    assert response["Cache-Control"] == "public, max-age=300, s-maxage=3600"
    assert response["ETag"].startswith('"')


def test_every_route_vertex_lies_inside_a_listed_cell_of_the_half_open_grid(
    client: Client, made: tuple[dict[str, Any], WeatherUpstream, datetime]
) -> None:
    plan, _, _ = made
    document = heatmap(client, plan["plan_id"]).json()
    grid, listed = document["grid"], set(document["cells"])

    for route in plan["routes"]:
        for lon, lat in route["geometry"]["coordinates"]:
            row = math.floor((lat - grid["lat0"]) / grid["dlat"])
            col = math.floor((lon - grid["lon0"]) / grid["dlon"])
            assert row * grid["cols"] + col in listed


def test_the_grid_has_its_origin_at_the_south_west_corner_and_samples_cell_centres(
    client: Client, made: tuple[dict[str, Any], WeatherUpstream, datetime]
) -> None:
    """D-22 end to end: every listed cell shows the weather of the lattice point at its centre.

    Wind and gust differ from place to place, so a grid mirrored north-south, shifted by half a
    cell or sampled at a corner would show another place's numbers somewhere and fail here.
    """
    plan, _, _ = made
    document = heatmap(client, plan["plan_id"]).json()
    grid, cells, fields = document["grid"], document["cells"], document["fields"]

    assert grid["dlat"] == grid["dlon"]
    assert round(grid["dlat"] * 10) in {2, 3, 4, 5}
    for position, index in enumerate(cells):
        lat, lon = cell_centre(grid, index)
        lat_e1, lon_e1 = lattice_of(lat, lon)
        assert lat == pytest.approx(lat_e1 / 10), "every centre lies on the 0.1 degree lattice"
        assert lon == pytest.approx(lon_e1 / 10)
        expected = distinct_per_place(lat_e1 / 10, lon_e1 / 10, datetime(2000, 1, 1, tzinfo=UTC))
        for frame in (0, 24, 48):
            offset = frame * len(cells) + position
            assert fields["wind_mph"][offset] == pytest.approx(
                expected["wind_speed_10m"], abs=0.051
            )
            assert fields["gust_mph"][offset] == pytest.approx(
                expected["wind_gusts_10m"], abs=0.051
            )
    assert len({fields["wind_mph"][position] for position in range(len(cells))}) > len(cells) // 2


def test_the_risk_of_a_cell_is_the_domains_risk_of_its_weather(
    client: Client, made: tuple[dict[str, Any], WeatherUpstream, datetime]
) -> None:
    """Load 38,000 lb: below 25 mph is Low, 25 to 35 Moderate, 35 to 45 High (LR-3 needs 40,000)."""
    plan, _, _ = made
    document = heatmap(client, plan["plan_id"]).json()
    wind, risk = document["fields"]["wind_mph"], document["fields"]["risk"]

    assert all(r == 0 for w, r in zip(wind, risk, strict=True) if w < 24.9)
    assert all(r == 1 for w, r in zip(wind, risk, strict=True) if 25.1 <= w < 34.9)
    assert all(r == 2 for w, r in zip(wind, risk, strict=True) if 35.1 <= w < 44.9)
    assert {0, 1, 2} <= set(risk)


# --------------------------------------------------------------------------- weather requests


def test_the_heatmap_asks_only_for_places_the_plan_did_not_and_over_the_49_hours(
    client: Client, made: tuple[dict[str, Any], WeatherUpstream, datetime]
) -> None:
    plan, weather, departure = made
    plan_points = set(weather.requested())
    assert weather.calls == 1

    heatmap(client, plan["plan_id"])

    assert weather.calls == 2
    heatmap_points = weather.requested()[len(plan_points) :]
    assert heatmap_points
    assert not plan_points & set(heatmap_points), "cached lattice points are not fetched again"
    form = weather.route.calls[1].request.content.decode().replace("%3A", ":")
    assert f"start_hour={departure.strftime('%Y-%m-%dT%H:%M')}" in form
    end = departure + 48 * HOUR
    assert f"end_hour={end.strftime('%Y-%m-%dT%H:%M')}" in form


def test_the_heatmap_is_computed_once_and_stored_on_the_plan(
    client: Client, made: tuple[dict[str, Any], WeatherUpstream, datetime]
) -> None:
    plan, weather, _ = made

    first = heatmap(client, plan["plan_id"])
    calls = weather.calls
    second = heatmap(client, plan["plan_id"])

    assert weather.calls == calls
    assert second.content == first.content
    assert second["ETag"] == first["ETag"]
    assert Plan.objects.get(id=plan["plan_id"]).heatmap == first.json()


def test_unknown_forecast_hours_are_null_and_risk_is_minus_one(
    client: Client, upstream: respx.MockRouter
) -> None:
    mock_routing(upstream, SLC_DENVER)
    weather = WeatherUpstream(upstream, benign)
    plan = post(client, body(SLC_DENVER, next_hour())).json()
    already_cached = {(round(lat * 10), round(lon * 10)) for lat, lon in weather.requested()}

    def east_is_unknown(lat: float, lon: float, stamp: datetime) -> Values:
        values = calm(lat, lon, stamp)
        return dict.fromkeys(values) if lon > -108.0 else values

    weather.script = east_is_unknown

    document = heatmap(client, plan["plan_id"]).json()

    fields, grid = document["fields"], document["grid"]
    centres = {index: cell_centre(grid, index) for index in document["cells"]}
    unknown = [
        position
        for position, index in enumerate(document["cells"])
        if centres[index][1] > -108.0 and lattice_of(*centres[index]) not in already_cached
    ]
    known = [position for position in range(len(document["cells"])) if position not in unknown]
    assert unknown
    assert known
    cells = len(document["cells"])
    for position in unknown:
        for frame in (0, 48):
            offset = frame * cells + position
            assert fields["risk"][offset] == -1
            assert all(
                fields[name][offset] is None
                for name in ("wind_mph", "gust_mph", "rain_in_hr", "snow_in_hr")
            )
    assert all(fields["risk"][position] >= 0 for position in known)


# --------------------------------------------------------------------------- scenarios


def test_a_scenario_heatmap_makes_no_upstream_call_and_shows_the_storm(
    client: Client, upstream: respx.MockRouter
) -> None:
    mock_routing(upstream, SLC_DENVER)
    weather = WeatherUpstream(upstream, benign)
    scenario = "storm-on-fastest"
    assert scenario in {item.id for item in scenario_catalog().summaries()}
    plan = post(client, body(SLC_DENVER, next_hour(), scenario=scenario)).json()

    response = heatmap(client, plan["plan_id"])

    document = response.json()
    assert response.status_code == 200
    assert weather.calls == 0
    assert document["sources"]["weather"] == "scenario"
    assert document["sources"]["scenario"] == scenario
    assert max(document["fields"]["risk"]) >= 2, "the scenario puts a storm on the fastest route"
    assert min(document["fields"]["risk"]) == 0


def test_a_scenario_heatmap_is_the_same_whenever_it_is_computed(
    client: Client, upstream: respx.MockRouter
) -> None:
    mock_routing(upstream, SLC_DENVER)
    WeatherUpstream(upstream, benign)
    plan = post(client, body(SLC_DENVER, next_hour(), scenario="storm-on-fastest")).json()
    first = heatmap(client, plan["plan_id"]).json()
    Plan.objects.filter(id=plan["plan_id"]).update(heatmap=None)

    again = heatmap(client, plan["plan_id"]).json()

    again["generated_at"] = first["generated_at"]
    assert again == first


# --------------------------------------------------------------------------- failures


def test_a_capacity_refusal_is_a_503_and_nothing_is_stored() -> None:
    weather = ScriptedWeather()
    under_test = build_services(ScriptedRouting(result_of(straight_route(300, points=60))), weather)
    plan_id = under_test.plans.create(request_for(interval=50)).document.plan_id
    weather.failure = ProviderRateLimitedError("open-meteo", "429", retry_after_s=12.0)

    with pytest.raises(ProblemError) as caught:
        under_test.heatmaps.get(plan_id)

    problem = caught.value
    assert (problem.code, problem.status, problem.retry_after_s) == (
        "weather_capacity_exhausted",
        503,
        12.0,
    )
    assert Plan.objects.get(id=plan_id).heatmap is None
    assert UpstreamBudget.objects.exists(), "the failed attempt stays charged: nothing is refunded"
    UpstreamBudget.objects.all().delete()  # the minute window has refilled by the retry
    weather.failure = None
    assert under_test.heatmaps.get(plan_id).plan_id == plan_id, "the next request tries again"


def test_a_heatmap_still_being_computed_elsewhere_is_a_retryable_503(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    under_test = build_services(ScriptedRouting(result_of(straight_route(300, points=60))))
    plan_id = under_test.plans.create(request_for(interval=50)).document.plan_id
    SingleFlightLease.objects.create(
        key=lease_key("heatmap", plan_id),
        holder="another-instance",
        expires_at=timezone.now() + timedelta(minutes=1),
    )
    monkeypatch.setattr(heatmap_module, "HEATMAP_BUDGET_S", 0.4)

    with pytest.raises(ProblemError) as caught:
        under_test.heatmaps.get(plan_id)

    assert (caught.value.code, caught.value.status, caught.value.retry_after_s) == (
        "service_unavailable",
        503,
        5.0,
    )


@pytest.mark.parametrize("plan_id", ["pln_" + "0" * 26, "nope", "pln_"])
def test_the_heatmap_of_an_unknown_plan_is_a_404_problem(client: Client, plan_id: str) -> None:
    response = heatmap(client, plan_id)

    assert response.status_code == 404
    assert response["Content-Type"] == "application/problem+json"
    assert response.json()["code"] == "plan_not_found"


def test_the_heatmap_of_an_expired_plan_is_a_404_problem(
    client: Client, made: tuple[dict[str, Any], WeatherUpstream, datetime]
) -> None:
    plan, _, _ = made
    assert heatmap(client, plan["plan_id"]).status_code == 200
    Plan.objects.filter(id=plan["plan_id"]).update(expires_at=datetime.now(UTC) - HOUR)

    assert heatmap(client, plan["plan_id"]).status_code == 404
