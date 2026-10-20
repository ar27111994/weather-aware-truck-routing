"""Provider selection for routing: Valhalla for trucks, OSRM for long hauls and as the fallback.

Decision D-17 in code. Valhalla's public server refuses trips whose end points are more than
1,500 km apart as the crow flies (error 154), so trips beyond 1,450 km (a margin under that limit)
go straight to OSRM's car router. Valhalla *failures* (timeout, 5xx, 429, a garbled answer, a trip
it refuses) fall back to OSRM as well, and each one is logged as a ``provider_failover`` event. One
provider serves a whole plan: when Valhalla answers with fewer than three routes the chain does
**not** top up from OSRM, because mixed routes come from different cost models and could not be
compared.

A truck's "no route" is not a failure and is final (R2-17). D-17 names the triggers of the car
fallback (timeout, 5xx, error 154), and "no route" is none of them: when the truck router says no
truck route exists, restrictions are the likely reason, and a car route handed to a truck driver
under a "truck routing is temporarily unavailable" warning would be both unsafe and a misstatement
of the cause. The trip is a 422 ``no_route_found``.

Every OSRM answer carries a warning that truck restrictions are not applied: the documented
"long-haul" message for trips beyond the Valhalla range, and a more accurate one when OSRM only
serves because truck routing is unavailable. Health tracking keeps a provider that keeps failing
out of the way for a cooldown instead of costing a timeout on every request. What says nothing
about a provider's health is not counted against it: a refused trip (our request), an exhausted
deadline (our time) and a refused shared budget (our allowance).

The shared routing budget is one allowance for both providers, so when it refuses a call the
search ends: asking the next provider would only be refused too.

Verdict when nobody delivers a route: *no route* when the truck router says so, or when the car
router does and no provider was down; otherwise the trip is merely *unserved* (retryable), with the
longest ``Retry-After`` any provider gave.
"""

from dataclasses import replace
from typing import Final

from haulcast.providers.errors import (
    ProviderError,
    ProviderRejectedError,
    ProviderUnavailableError,
    UpstreamBudgetExhaustedError,
)
from haulcast.providers.failover import blames_provider, record_failover, record_skip
from haulcast.providers.health import ProviderHealth
from haulcast.providers.routing.base import (
    FALLBACK_WARNING_CODE,
    FALLBACK_WARNING_MESSAGE,
    LONG_HAUL_WARNING_CODE,
    LONG_HAUL_WARNING_MESSAGE,
    Coordinate,
    NoRouteFoundError,
    ProviderWarning,
    RoutingProvider,
    RoutingResult,
    RoutingUnavailableError,
)
from haulcast.providers.routing.geometry import great_circle_km

CHAIN_NAME: Final = "routing-chain"
LONG_HAUL_THRESHOLD_KM: Final = 1450.0
"""Margin under the 1,500 km range limit of the Valhalla public server."""


class RoutingChain:
    """Routes through Valhalla when it can, through OSRM when it must."""

    name = CHAIN_NAME

    def __init__(
        self,
        valhalla: RoutingProvider,
        osrm: RoutingProvider,
        *,
        health: ProviderHealth,
        long_haul_threshold_km: float = LONG_HAUL_THRESHOLD_KM,
    ) -> None:
        """Bind the truck provider, the car provider, their ``health`` tracker and the range."""
        self._valhalla = valhalla
        self._osrm = osrm
        self._health = health
        self._long_haul_threshold_km = long_haul_threshold_km

    def route(
        self,
        origin: Coordinate,
        destination: Coordinate,
        *,
        load_weight_lb: int,
    ) -> RoutingResult:
        """Return the routes of the first provider that can serve the trip.

        Raises:
            NoRouteFoundError: the truck router says no route exists, or the car router does and
                nobody was down.
            RoutingUnavailableError: nobody could serve the trip (and it is not a "no route").
        """
        long_haul = great_circle_km(origin, destination) > self._long_haul_threshold_km
        providers = (self._osrm,) if long_haul else (self._valhalla, self._osrm)
        no_route = 0
        unavailable: list[ProviderError] = []
        for provider in providers:
            if not self._health.available(provider.name):
                record_skip(CHAIN_NAME, provider.name)
                unavailable.append(ProviderUnavailableError(provider.name, "cooling down"))
                continue
            try:
                result = provider.route(origin, destination, load_weight_lb=load_weight_lb)
            except NoRouteFoundError as exc:
                self._health.record_success(provider.name)  # it answered; there is just no route
                if provider is self._valhalla:
                    raise NoRouteFoundError(CHAIN_NAME, "no route between these places") from exc
                no_route += 1
                continue
            except UpstreamBudgetExhaustedError as exc:
                unavailable.append(exc)
                break  # the next provider draws from the same allowance
            except ProviderError as exc:
                if blames_provider(exc):
                    self._health.record_failure(provider.name)
                if not isinstance(exc, ProviderRejectedError):
                    unavailable.append(exc)  # a refused trip is no verdict either way
                record_failover(CHAIN_NAME, provider.name, exc)
                continue
            self._health.record_success(provider.name)
            return self._with_warning(result, long_haul=long_haul)
        if no_route and not unavailable:
            raise NoRouteFoundError(CHAIN_NAME, "no route between these places")
        hints = [
            error.retry_after_s
            for error in unavailable
            if isinstance(error, ProviderUnavailableError) and error.retry_after_s is not None
        ]
        raise RoutingUnavailableError(
            "no routing provider could serve this trip", retry_after_s=max(hints, default=None)
        )

    def _with_warning(self, result: RoutingResult, *, long_haul: bool) -> RoutingResult:
        """Prepend the car-routing warning when the answer came from the OSRM car router."""
        if result.provider != self._osrm.name:
            return result
        warning = (
            ProviderWarning(LONG_HAUL_WARNING_CODE, LONG_HAUL_WARNING_MESSAGE)
            if long_haul
            else ProviderWarning(FALLBACK_WARNING_CODE, FALLBACK_WARNING_MESSAGE)
        )
        return replace(result, warnings=(warning, *result.warnings))
