"""Concurrency: identical plan requests compute once, first heatmap requests compute once."""

from typing import Any

import pytest
from django.test import Client

import haulcast.api.plans as plans_api
from haulcast.providers.routing.base import RoutingResult
from haulcast.services.routing import RoutingService, route_cache
from haulcast.store.models import Plan
from tests.plans.fakes import (
    ScriptedRouting,
    ScriptedWeather,
    build_services,
    request_for,
    result_of,
    straight_route,
)
from tests.plans.support import PLANS, SLC_DENVER, body
from tests.services.conftest import run_concurrently

pytestmark = pytest.mark.django_db(transaction=True)

THREADS = 5


def test_five_identical_concurrent_posts_compute_once_and_share_one_plan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    routing = ScriptedRouting(result_of(straight_route(300, points=60)), delay_s=0.5)
    weather = ScriptedWeather()
    services = build_services(routing, weather)
    monkeypatch.setattr(plans_api, "plan_service", lambda: services.plans)
    payload = body(SLC_DENVER, request_for().departure, interval=50)

    def work(_: int) -> tuple[int, str]:
        response = Client().post(PLANS, data=payload, content_type="application/json")
        return response.status_code, str(response.json()["plan_id"])

    results = run_concurrently(THREADS, work)

    assert sorted(status for status, _ in results) == [200, 200, 200, 200, 201]
    assert len({plan_id for _, plan_id in results}) == 1
    assert len(routing.calls) == 1
    assert len(weather.fetches) == 1
    assert Plan.objects.count() == 1


def test_concurrent_requests_for_one_trip_ask_the_routing_provider_once() -> None:
    routing = ScriptedRouting(result_of(straight_route(100, points=10)), delay_s=0.5)
    routes = RoutingService(routing, route_cache())

    def work(_: int) -> RoutingResult:
        return routes.routes((-111.891, 40.7608), (-104.9903, 39.7392), 38_000)

    results = run_concurrently(THREADS, work)

    assert len(routing.calls) == 1
    assert all(result == results[0] for result in results)


def test_concurrent_first_heatmap_requests_compute_the_heatmap_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    weather = ScriptedWeather()
    services = build_services(ScriptedRouting(result_of(straight_route(300, points=60))), weather)
    monkeypatch.setattr(plans_api, "heatmap_service", lambda: services.heatmaps)
    plan_id = services.plans.create(request_for(interval=50)).document.plan_id
    assert len(weather.fetches) == 1
    weather.delay_s = 0.5

    def work(_: int) -> tuple[int, str, bytes]:
        response = Client().get(f"/api/v1/plans/{plan_id}/heatmap")
        return response.status_code, response["ETag"], response.content

    results: list[tuple[int, str, Any]] = run_concurrently(THREADS, work)

    assert [status for status, _, _ in results] == [200] * THREADS
    assert len({etag for _, etag, _ in results}) == 1
    assert len({content for _, _, content in results}) == 1
    assert len(weather.fetches) == 2, "one fetch for the plan, one for the heatmap, not five"
    assert Plan.objects.get(id=plan_id).heatmap is not None
