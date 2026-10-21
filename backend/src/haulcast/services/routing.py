"""Routing use case: the provider chain behind a 24-hour route cache, failures as problems.

The cache key is the trip (both places at request precision, four decimals) and the load: a
truck's route depends on its weight, so a lighter load must not be served a heavier one's route.
Only successes are cached: a refused trip or an outage is retried on the next request. Concurrent
identical requests share one provider call (single-flight, see ``services.cache.JsonCache``).
"""

from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Final

from haulcast.problems import ProblemCode, ProblemError
from haulcast.providers.routing.base import (
    Coordinate,
    NoRouteFoundError,
    ProviderWarning,
    RouteOption,
    RoutingProvider,
    RoutingResult,
    RoutingUnavailableError,
)
from haulcast.services.cache import CacheSpec, JsonCache, utc_now
from haulcast.store.models import RouteCache

ROUTE_TTL: Final = timedelta(hours=24)


def _encode(result: RoutingResult) -> object:
    return {
        "provider": result.provider,
        "routes": [
            {
                "coords": [list(coord) for coord in route.coords],
                "cum_s": list(route.cum_s),
                "distance_mi": route.distance_mi,
                "duration_s": route.duration_s,
                "summary": route.summary,
            }
            for route in result.routes
        ],
        "warnings": [{"code": item.code, "message": item.message} for item in result.warnings],
    }


def _decode(payload: object) -> RoutingResult:
    if not isinstance(payload, dict):
        raise TypeError("route cache payload must be an object")
    return RoutingResult(
        provider=str(payload["provider"]),
        routes=tuple(
            RouteOption(
                coords=tuple((float(lon), float(lat)) for lon, lat in route["coords"]),
                cum_s=tuple(float(seconds) for seconds in route["cum_s"]),
                distance_mi=float(route["distance_mi"]),
                duration_s=float(route["duration_s"]),
                summary=str(route["summary"]),
            )
            for route in payload["routes"]
        ),
        warnings=tuple(
            ProviderWarning(code=str(item["code"]), message=str(item["message"]))
            for item in payload["warnings"]
        ),
    )


def route_cache(clock: Callable[[], datetime] = utc_now) -> JsonCache[RoutingResult, RouteCache]:
    """Build the production route cache (tests inject ``clock`` to expire entries)."""
    spec = CacheSpec[RoutingResult](
        name="route",
        provider="routing-chain",
        ttl=ROUTE_TTL,
        encode=_encode,
        decode=_decode,
    )
    return JsonCache(spec, model=RouteCache, manager=RouteCache.objects, clock=clock)


class RoutingService:
    """Finds the route options of a trip, from cache or from the provider chain."""

    def __init__(
        self, provider: RoutingProvider, cache: JsonCache[RoutingResult, RouteCache]
    ) -> None:
        """Wire the (chained) ``provider`` and the read-through ``cache``."""
        self._provider = provider
        self._cache = cache

    def routes(
        self, origin: Coordinate, destination: Coordinate, load_weight_lb: int
    ) -> RoutingResult:
        """Return the distinct routes from ``origin`` to ``destination`` (``(lon, lat)`` pairs).

        Raises:
            ProblemError: ``no_route_found`` (422) when no provider finds a drivable route,
                ``routing_unavailable`` (503, with ``Retry-After`` when known) when none could
                be asked.
        """
        key = (
            f"route:{origin[0]:.4f},{origin[1]:.4f};"
            f"{destination[0]:.4f},{destination[1]:.4f}|{load_weight_lb}"
        )
        try:
            return self._cache.get_or_load(
                key,
                lambda: self._provider.route(origin, destination, load_weight_lb=load_weight_lb),
            )
        except NoRouteFoundError as exc:
            raise ProblemError(
                ProblemCode.NO_ROUTE_FOUND, detail="No drivable route connects these two places."
            ) from exc
        except RoutingUnavailableError as exc:
            raise ProblemError(
                ProblemCode.ROUTING_UNAVAILABLE,
                detail="Routing is temporarily unavailable.",
                retry_after_s=exc.retry_after_s,
            ) from exc
