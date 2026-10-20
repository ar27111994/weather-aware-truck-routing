"""Concurrency: identical plan requests compute once, first heatmap requests compute once."""

import threading
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import pytest
from django.db import connection
from django.test import Client

import haulcast.api.plans as plans_api
from haulcast.providers.routing.base import RoutingResult
from haulcast.providers.weather.base import HourlyForecast, HourWindow, LatticePoint
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


@dataclass
class SpyWeather(ScriptedWeather):
    """Calm weather that notes whether a transaction was open while it was being fetched."""

    open_transactions: list[bool] = field(default_factory=list)

    def fetch(
        self, points: Sequence[LatticePoint], window: HourWindow
    ) -> dict[LatticePoint, HourlyForecast]:
        self.open_transactions.append(connection.in_atomic_block)
        return super().fetch(points, window)


def test_plans_for_different_trips_are_inside_routing_at_the_same_time() -> None:
    both_inside = threading.Barrier(2, timeout=30)
    routing = ScriptedRouting(result_of(straight_route(300, points=60)))
    routing.on_call.append(both_inside.wait)  # each answers only once the other plan is here too
    services = build_services(routing, ScriptedWeather())
    requests = [
        request_for(miles_apart=200, interval=50),
        request_for(miles_apart=250, interval=50),
    ]

    def work(index: int) -> str:
        return services.plans.create(requests[index]).document.plan_id

    plan_ids = run_concurrently(2, work)

    # Plans for different corridors used to queue behind one advisory lock per hour.
    assert len(set(plan_ids)) == 2
    assert len(routing.calls) == 2


def test_no_transaction_is_open_while_a_plan_waits_for_its_providers() -> None:
    open_during_routing: list[bool] = []
    routing = ScriptedRouting(result_of(straight_route(300, points=60)))
    routing.on_call.append(lambda: open_during_routing.append(connection.in_atomic_block))
    weather = SpyWeather()

    build_services(routing, weather).plans.create(request_for(interval=50))

    # T5b: a plan used to hold one pooled connection for up to 25 s (an advisory lock taken
    # inside a transaction that spanned the whole computation).
    assert open_during_routing == [False]
    assert weather.open_transactions == [False]
