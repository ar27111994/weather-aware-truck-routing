"""Provider selection for routing: Valhalla for trucks, OSRM for long hauls and as the fallback.

Decision D-17 in code. Valhalla's public server refuses trips whose end points are more than
1,500 km apart as the crow flies (error 154), so trips beyond 1,450 km (a margin under that limit)
go straight to OSRM's car router. Valhalla failures (timeout, 5xx, 429, a garbled answer, a refused
or unroutable trip) fall back to OSRM as well. One provider serves a whole plan: when Valhalla
answers with fewer than three routes the chain does **not** top up from OSRM, because mixed routes
come from different cost models and could not be compared.

Every OSRM answer carries a warning that truck restrictions are not applied: the documented
"long-haul" message for trips beyond the Valhalla range, and a more accurate one when OSRM only
serves because truck routing is unavailable. Health tracking keeps a provider that keeps failing
out of the way for a cooldown instead of costing a timeout on every request.

Verdict when nobody delivers a route: *no route* only if every provider that was asked said so
and none was down; otherwise the trip is merely *unserved* (retryable), with the longest
``Retry-After`` any provider gave.
"""

from dataclasses import replace
from typing import Final

from haulcast.providers.errors import (
    ProviderError,
    ProviderRejectedError,
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
            NoRouteFoundError: every provider that was asked says no route connects the points.
            RoutingUnavailableError: nobody could serve the trip (and it is not a "no route").
        """
        long_haul = great_circle_km(origin, destination) > self._long_haul_threshold_km
        providers = (self._osrm,) if long_haul else (self._valhalla, self._osrm)
        no_route = 0
        unavailable: list[ProviderError] = []
        for provider in providers:
            if not self._health.available(provider.name):
                unavailable.append(ProviderUnavailableError(provider.name, "cooling down"))
                continue
            try:
                result = provider.route(origin, destination, load_weight_lb=load_weight_lb)
            except NoRouteFoundError:
                self._health.record_success(provider.name)  # it answered; there is just no route
                no_route += 1
                continue
            except ProviderRejectedError:
                continue  # our request, not the provider's health: no verdict either way
            except ProviderError as exc:
                self._health.record_failure(provider.name)
                unavailable.append(exc)
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
