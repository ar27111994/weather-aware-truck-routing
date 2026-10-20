"""The routing service: route cache, key, codec, failure mapping."""

import pytest

from haulcast.problems import ProblemError
from haulcast.providers.routing.base import (
    NoRouteFoundError,
    ProviderWarning,
    RoutingResult,
    RoutingUnavailableError,
)
from haulcast.services.routing import ROUTE_TTL, RoutingService, route_cache
from haulcast.store.models import RouteCache
from tests.plans.fakes import FIXED_NOW, Clock, ScriptedRouting, result_of, straight_route

pytestmark = pytest.mark.django_db

ORIGIN = (-111.891, 40.7608)
DESTINATION = (-104.9903, 39.7392)


def service(routing: ScriptedRouting, clock: Clock | None = None) -> RoutingService:
    return RoutingService(routing, route_cache(clock=clock or Clock()))


def answer() -> RoutingResult:
    return RoutingResult(
        provider="osrm",
        routes=(straight_route(100, points=5), straight_route(120, points=7)),
        warnings=(ProviderWarning("long_haul_no_truck_restrictions", "Long-haul route."),),
    )


def test_a_trip_is_routed_once_and_then_served_from_the_cache_unchanged() -> None:
    routing = ScriptedRouting(answer())
    under_test = service(routing)

    first = under_test.routes(ORIGIN, DESTINATION, 38_000)
    second = under_test.routes(ORIGIN, DESTINATION, 38_000)

    assert len(routing.calls) == 1
    assert first == answer()
    assert second == first, "the decoded answer is the provider's answer, warnings included"
    assert RouteCache.objects.count() == 1


def test_a_cached_route_expires_after_24_hours() -> None:
    clock = Clock()
    routing = ScriptedRouting(answer())
    under_test = service(routing, clock)
    under_test.routes(ORIGIN, DESTINATION, 38_000)

    clock.now = FIXED_NOW + ROUTE_TTL - (ROUTE_TTL / 1_000)
    under_test.routes(ORIGIN, DESTINATION, 38_000)
    assert len(routing.calls) == 1
    clock.now = FIXED_NOW + ROUTE_TTL
    under_test.routes(ORIGIN, DESTINATION, 38_000)

    assert len(routing.calls) == 2


@pytest.mark.parametrize(
    ("origin", "destination", "load"),
    [
        ((-111.8911, 40.7608), DESTINATION, 38_000),
        (ORIGIN, (-104.9903, 39.7393), 38_000),
        (ORIGIN, DESTINATION, 38_001),
        (DESTINATION, ORIGIN, 38_000),
    ],
    ids=["origin", "destination", "load", "reversed"],
)
def test_the_cache_key_is_both_places_and_the_load(
    origin: tuple[float, float], destination: tuple[float, float], load: int
) -> None:
    routing = ScriptedRouting(answer())
    under_test = service(routing)
    under_test.routes(ORIGIN, DESTINATION, 38_000)

    under_test.routes(origin, destination, load)

    assert len(routing.calls) == 2
    assert routing.calls[1] == (origin, destination, load)


def test_a_stored_answer_that_no_longer_decodes_is_replaced() -> None:
    routing = ScriptedRouting(answer())
    key = "route:-111.8910,40.7608;-104.9903,39.7392|38000"
    RouteCache.objects.create(
        key=key,
        payload=["not", "a", "route"],
        provider="routing-chain",
        expires_at=FIXED_NOW.replace(year=2030),
    )

    result = service(routing).routes(ORIGIN, DESTINATION, 38_000)

    assert result == answer()
    assert len(routing.calls) == 1
    assert isinstance(RouteCache.objects.get(key=key).payload, dict)


def test_no_route_becomes_a_422_problem() -> None:
    routing = ScriptedRouting(NoRouteFoundError("scripted", "none"))

    with pytest.raises(ProblemError) as caught:
        service(routing).routes(ORIGIN, DESTINATION, 0)

    assert (caught.value.code, caught.value.status) == ("no_route_found", 422)
    assert RouteCache.objects.count() == 0


def test_an_outage_becomes_a_503_problem_with_the_providers_retry_hint() -> None:
    routing = ScriptedRouting(RoutingUnavailableError("down", retry_after_s=3.0))

    with pytest.raises(ProblemError) as caught:
        service(routing).routes(ORIGIN, DESTINATION, 0)

    assert (caught.value.code, caught.value.status, caught.value.retry_after_s) == (
        "routing_unavailable",
        503,
        3.0,
    )
    assert RouteCache.objects.count() == 0


def test_the_provider_is_asked_with_the_load_it_was_given() -> None:
    routing = ScriptedRouting(result_of(straight_route(50, points=4)))

    service(routing).routes(ORIGIN, DESTINATION, 12_345)

    assert routing.calls == [(ORIGIN, DESTINATION, 12_345)]
