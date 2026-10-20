"""Tests of the routing chain: provider selection (D-17), fallback, health and honest warnings."""

import httpx
import pytest

from haulcast.providers.errors import (
    ProviderError,
    ProviderRateLimitedError,
    ProviderRejectedError,
    ProviderResponseError,
    ProviderUnavailableError,
)
from haulcast.providers.health import ProviderHealth
from haulcast.providers.routing.base import (
    FALLBACK_WARNING_CODE,
    FALLBACK_WARNING_MESSAGE,
    LONG_HAUL_WARNING_CODE,
    LONG_HAUL_WARNING_MESSAGE,
    Coordinate,
    NoRouteFoundError,
    ProviderWarning,
    RouteOption,
    RoutingProvider,
    RoutingResult,
    RoutingUnavailableError,
    fewer_routes_warning,
)
from haulcast.providers.routing.chain import RoutingChain
from tests.providers.routing import test_osrm, test_valhalla
from tests.providers.routing.support import FakeClock, json_response

ORIGIN: Coordinate = (-111.891, 40.7608)
NEAR: Coordinate = (-104.9903, 39.7392)
EQUATOR_START: Coordinate = (0.0, 0.0)
JUST_INSIDE: Coordinate = (13.04, 0.0)  # 1,449.9 km along the equator
JUST_OUTSIDE: Coordinate = (13.05, 0.0)  # 1,451.1 km


def route(label: str = "via test") -> RouteOption:
    return RouteOption(
        coords=((0.0, 0.0), (0.0, 1.0)),
        cum_s=(0.0, 100.0),
        distance_mi=69.0,
        duration_s=100.0,
        summary=label,
    )


class FakeProvider:
    """A scripted routing provider: every call pops the next outcome (a result or an error)."""

    def __init__(self, name: str, *outcomes: RoutingResult | Exception) -> None:
        self.name = name
        self._outcomes = list(outcomes)
        self.calls: list[tuple[Coordinate, Coordinate, int]] = []

    def route(
        self, origin: Coordinate, destination: Coordinate, *, load_weight_lb: int
    ) -> RoutingResult:
        self.calls.append((origin, destination, load_weight_lb))
        outcome = self._outcomes.pop(0) if len(self._outcomes) > 1 else self._outcomes[0]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def result_of(provider: str, *warnings: ProviderWarning) -> RoutingResult:
    return RoutingResult(provider, (route("a"), route("b"), route("c")), warnings)


def chain_of(
    valhalla: RoutingProvider, osrm: RoutingProvider, clock: FakeClock | None = None
) -> RoutingChain:
    health = ProviderHealth(failure_threshold=3, cooldown_s=30.0, clock=clock or FakeClock())
    return RoutingChain(valhalla, osrm, health=health)


def go(chain: RoutingChain, destination: Coordinate = NEAR) -> RoutingResult:
    return chain.route(ORIGIN, destination, load_weight_lb=38_000)


UNAVAILABLE = ProviderUnavailableError("valhalla", "HTTP 503")


# --------------------------------------------------------------------------- selection


def test_a_trip_within_the_valhalla_range_is_served_by_valhalla_and_passed_on_untouched() -> None:
    valhalla = FakeProvider("valhalla", result_of("valhalla"))
    osrm = FakeProvider("osrm", result_of("osrm"))

    result = go(chain_of(valhalla, osrm))

    assert result == result_of("valhalla")
    assert osrm.calls == []
    assert valhalla.calls == [(ORIGIN, NEAR, 38_000)]


def test_valhalla_warnings_such_as_too_few_routes_are_kept() -> None:
    warning = fewer_routes_warning(2)
    valhalla = FakeProvider("valhalla", result_of("valhalla", warning))

    assert go(chain_of(valhalla, FakeProvider("osrm", result_of("osrm")))).warnings == (warning,)


def test_the_boundary_is_1450_km_as_the_crow_flies() -> None:
    inside = FakeProvider("valhalla", result_of("valhalla"))
    outside_osrm = FakeProvider("osrm", result_of("osrm"))

    assert (
        chain_of(inside, outside_osrm).route(EQUATOR_START, JUST_INSIDE, load_weight_lb=0).provider
        == "valhalla"
    )
    assert (
        chain_of(inside, outside_osrm).route(EQUATOR_START, JUST_OUTSIDE, load_weight_lb=0).provider
        == "osrm"
    )


def test_a_long_haul_goes_straight_to_osrm_with_the_documented_warning() -> None:
    valhalla = FakeProvider("valhalla", result_of("valhalla"))
    osrm = FakeProvider("osrm", result_of("osrm"))

    result = chain_of(valhalla, osrm).route(
        (-118.2437, 34.0522), (-74.0060, 40.7128), load_weight_lb=38_000
    )

    assert result.provider == "osrm"
    assert result.warnings == (ProviderWarning(LONG_HAUL_WARNING_CODE, LONG_HAUL_WARNING_MESSAGE),)
    assert LONG_HAUL_WARNING_MESSAGE == (
        "Long-haul route: truck restrictions are not applied by the routing service."
    )
    assert valhalla.calls == []


def test_osrm_warnings_follow_the_chains_own_warning() -> None:
    few = fewer_routes_warning(1)
    osrm = FakeProvider("osrm", result_of("osrm", few))

    result = chain_of(FakeProvider("valhalla", result_of("valhalla")), osrm).route(
        EQUATOR_START, JUST_OUTSIDE, load_weight_lb=0
    )

    assert [warning.code for warning in result.warnings] == [
        LONG_HAUL_WARNING_CODE,
        "fewer_than_3_distinct_routes",
    ]


def test_valhalla_is_never_topped_up_with_osrm_routes() -> None:
    valhalla = FakeProvider("valhalla", result_of("valhalla", fewer_routes_warning(2)))
    osrm = FakeProvider("osrm", result_of("osrm"))

    go(chain_of(valhalla, osrm))

    assert osrm.calls == []  # one provider per plan


# ---------------------------------------------------------------------------- fallback


@pytest.mark.parametrize(
    "failure",
    [
        UNAVAILABLE,
        ProviderRateLimitedError("valhalla", "rate limited (HTTP 429)", retry_after_s=3.0),
        ProviderResponseError("valhalla", "response is not valid JSON"),
        ProviderRejectedError("valhalla", "HTTP 400: too far", status=400, code="154"),
        NoRouteFoundError("valhalla", "no route between these places"),
    ],
    ids=["unavailable", "rate-limited", "garbled", "too-far", "no-route"],
)
def test_when_valhalla_cannot_serve_a_trip_osrm_does_with_an_honest_warning(
    failure: ProviderError,
) -> None:
    valhalla = FakeProvider("valhalla", failure)
    osrm = FakeProvider("osrm", result_of("osrm"))

    result = go(chain_of(valhalla, osrm))

    assert result.provider == "osrm"
    assert result.warnings == (ProviderWarning(FALLBACK_WARNING_CODE, FALLBACK_WARNING_MESSAGE),)
    assert len(osrm.calls) == 1


def test_a_provider_that_keeps_failing_is_skipped_until_its_cooldown_ends() -> None:
    clock = FakeClock()
    valhalla = FakeProvider("valhalla", UNAVAILABLE)
    osrm = FakeProvider("osrm", result_of("osrm"))
    chain = chain_of(valhalla, osrm, clock)

    for _ in range(3):
        go(chain)
    assert len(valhalla.calls) == 3

    go(chain)  # the circuit is open: straight to OSRM
    assert len(valhalla.calls) == 3

    clock.advance(31.0)
    go(chain)
    assert len(valhalla.calls) == 4


def test_requests_valhalla_cannot_serve_do_not_count_against_its_health() -> None:
    valhalla = FakeProvider(
        "valhalla",
        ProviderRejectedError("valhalla", "too far", status=400, code="154"),
        NoRouteFoundError("valhalla", "no route"),
    )
    chain = chain_of(valhalla, FakeProvider("osrm", result_of("osrm")))

    for _ in range(8):
        go(chain)

    assert len(valhalla.calls) == 8


def test_a_success_ends_the_failure_streak() -> None:
    valhalla = FakeProvider(
        "valhalla", UNAVAILABLE, UNAVAILABLE, result_of("valhalla"), UNAVAILABLE, UNAVAILABLE
    )
    chain = chain_of(valhalla, FakeProvider("osrm", result_of("osrm")))

    for _ in range(5):
        go(chain)

    assert len(valhalla.calls) == 5


def test_a_bug_in_a_provider_is_not_swallowed() -> None:
    valhalla = FakeProvider("valhalla", ValueError("programming error"))

    with pytest.raises(ValueError, match="programming error"):
        go(chain_of(valhalla, FakeProvider("osrm", result_of("osrm"))))


# ----------------------------------------------------------------------------- failure


def test_when_both_fail_the_error_carries_the_largest_retry_hint() -> None:
    valhalla = FakeProvider(
        "valhalla", ProviderRateLimitedError("valhalla", "429", retry_after_s=2.0)
    )
    osrm = FakeProvider("osrm", ProviderUnavailableError("osrm", "HTTP 502", retry_after_s=9.0))

    with pytest.raises(RoutingUnavailableError) as excinfo:
        go(chain_of(valhalla, osrm))

    assert excinfo.value.retry_after_s == 9.0
    assert excinfo.value.provider == "routing"


def test_without_a_hint_the_error_has_none() -> None:
    valhalla = FakeProvider("valhalla", UNAVAILABLE)
    osrm = FakeProvider("osrm", ProviderResponseError("osrm", "garbled"))

    with pytest.raises(RoutingUnavailableError) as excinfo:
        go(chain_of(valhalla, osrm))

    assert excinfo.value.retry_after_s is None


def test_both_providers_answering_no_route_means_there_is_no_route() -> None:
    valhalla = FakeProvider("valhalla", NoRouteFoundError("valhalla", "none"))
    osrm = FakeProvider("osrm", NoRouteFoundError("osrm", "none"))

    with pytest.raises(NoRouteFoundError):
        go(chain_of(valhalla, osrm))


def test_a_long_haul_with_no_route_means_there_is_no_route() -> None:
    osrm = FakeProvider("osrm", NoRouteFoundError("osrm", "none"))

    with pytest.raises(NoRouteFoundError):
        chain_of(FakeProvider("valhalla", result_of("valhalla")), osrm).route(
            EQUATOR_START, JUST_OUTSIDE, load_weight_lb=0
        )


def test_no_route_from_a_provider_that_was_too_far_is_still_no_route() -> None:
    valhalla = FakeProvider("valhalla", ProviderRejectedError("v", "far", status=400, code="154"))
    osrm = FakeProvider("osrm", NoRouteFoundError("osrm", "none"))

    with pytest.raises(NoRouteFoundError):
        go(chain_of(valhalla, osrm))


def test_no_route_is_not_claimed_when_the_second_opinion_is_missing() -> None:
    valhalla = FakeProvider("valhalla", NoRouteFoundError("valhalla", "none"))
    osrm = FakeProvider("osrm", ProviderUnavailableError("osrm", "HTTP 502"))

    with pytest.raises(RoutingUnavailableError):
        go(chain_of(valhalla, osrm))


def test_rejections_alone_leave_the_trip_unserved() -> None:
    valhalla = FakeProvider("valhalla", ProviderRejectedError("v", "far", status=400, code="154"))
    osrm = FakeProvider("osrm", ProviderRejectedError("o", "bad query", status=400, code="X"))

    with pytest.raises(RoutingUnavailableError):
        go(chain_of(valhalla, osrm))


def test_with_every_provider_cooling_down_nobody_is_called() -> None:
    clock = FakeClock()
    valhalla = FakeProvider("valhalla", UNAVAILABLE)
    osrm = FakeProvider("osrm", ProviderUnavailableError("osrm", "HTTP 502"))
    chain = chain_of(valhalla, osrm, clock)
    for _ in range(3):
        with pytest.raises(RoutingUnavailableError):
            go(chain)
    calls = (len(valhalla.calls), len(osrm.calls))

    with pytest.raises(RoutingUnavailableError):
        go(chain)

    assert (len(valhalla.calls), len(osrm.calls)) == calls


def test_the_chain_is_itself_a_routing_provider() -> None:
    chain: RoutingProvider = chain_of(FakeProvider("a", result_of("a")), FakeProvider("b"))
    assert chain.name == "routing-chain"


# --------------------------------------------------- the real adapters on the recordings


def real_chain(valhalla_base: str | None, osrm_base: str | None, clock: FakeClock) -> RoutingChain:
    def valhalla_handler(request: httpx.Request) -> httpx.Response:
        if valhalla_base is None:
            return httpx.Response(503)
        return test_valhalla.ValhallaDouble(valhalla_base)(request)

    def osrm_handler(_request: httpx.Request) -> httpx.Response:
        if osrm_base is None:
            return httpx.Response(502)
        return json_response(osrm_base)

    return chain_of(
        test_valhalla.provider_for(valhalla_handler, clock=clock),
        test_osrm.provider_for(osrm_handler, clock=clock),
        clock,
    )


def test_salt_lake_city_to_denver_is_three_valhalla_truck_routes_without_warnings() -> None:
    chain = real_chain("valhalla-slc-den-truck-alt2.json", "osrm-slc-den-alt3.json", FakeClock())

    result = chain.route(ORIGIN, NEAR, load_weight_lb=38_000)

    assert result.provider == "valhalla"
    assert len(result.routes) == 3
    assert result.warnings == ()


def test_los_angeles_to_new_york_is_osrm_car_routing_with_the_long_haul_warning() -> None:
    chain = real_chain(None, "osrm-la-nyc-alt3.json", FakeClock())

    result = chain.route((-118.2437, 34.0522), (-74.0060, 40.7128), load_weight_lb=38_000)

    assert result.provider == "osrm"
    assert result.warnings[0].code == LONG_HAUL_WARNING_CODE
    assert result.routes[0].distance_mi == pytest.approx(2793.7, abs=0.1)


def test_a_valhalla_outage_on_a_short_trip_falls_back_to_osrm_car_routes() -> None:
    chain = real_chain(None, "osrm-slc-den-alt3.json", FakeClock())

    result = chain.route(ORIGIN, NEAR, load_weight_lb=38_000)

    assert result.provider == "osrm"
    assert result.warnings[0].code == FALLBACK_WARNING_CODE
