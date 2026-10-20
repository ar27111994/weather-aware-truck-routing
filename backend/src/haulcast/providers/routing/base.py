"""Provider-neutral routing types and the interface every routing adapter implements."""

from dataclasses import dataclass
from typing import Final, Protocol

from haulcast.providers.errors import ProviderError

Coordinate = tuple[float, float]
"""``(longitude, latitude)`` in WGS84 degrees: GeoJSON order, as used by ``haulcast.domain``."""

LONG_HAUL_WARNING_CODE: Final = "long_haul_no_truck_restrictions"
LONG_HAUL_WARNING_MESSAGE: Final = (
    "Long-haul route: truck restrictions are not applied by the routing service."
)
FALLBACK_WARNING_CODE: Final = "truck_routing_unavailable"
FALLBACK_WARNING_MESSAGE: Final = (
    "Truck routing is temporarily unavailable: this route is calculated for cars and "
    "truck restrictions are not applied."
)
FEWER_ROUTES_WARNING_CODE: Final = "fewer_than_3_distinct_routes"


@dataclass(frozen=True, slots=True)
class ProviderWarning:
    """A condition the traveller should be told about, with a stable machine-readable ``code``."""

    code: str
    message: str


def fewer_routes_warning(count: int) -> ProviderWarning:
    """Return the warning for a trip that has fewer than three distinct routes (``count`` exist)."""
    noun = "route" if count == 1 else "routes"
    verb = "exists" if count == 1 else "exist"
    return ProviderWarning(
        FEWER_ROUTES_WARNING_CODE,
        f"Only {count} distinct {noun} {verb} between these places.",
    )


@dataclass(frozen=True, slots=True)
class RouteOption:
    """One drivable route as the provider reported it, ready for ``haulcast.domain.build_path``.

    ``coords`` and ``cum_s`` have the same length: ``cum_s[i]`` is the cumulative travel time in
    seconds at ``coords[i]`` (``cum_s[0] == 0``, non-decreasing, ``cum_s[-1] == duration_s``).
    ``distance_mi`` and ``duration_s`` are the provider's own totals, which the domain keeps as the
    displayed truth. ``summary`` is the normalised "via I-80, I-25" label.
    """

    coords: tuple[Coordinate, ...]
    cum_s: tuple[float, ...]
    distance_mi: float
    duration_s: float
    summary: str


@dataclass(frozen=True, slots=True)
class RoutingResult:
    """The routes one provider found for one trip, plus anything the traveller should know.

    All routes come from the same ``provider``: providers are never mixed within one plan. Routes
    are pairwise distinct (overlap below the configured threshold) and in the provider's own order.
    """

    provider: str
    routes: tuple[RouteOption, ...]
    warnings: tuple[ProviderWarning, ...] = ()


class NoRouteFoundError(ProviderError):
    """The routing service reports that no drivable route connects the two points."""


class RoutingUnavailableError(ProviderError):
    """Every routing provider failed; ``retry_after_s`` carries the upstream's hint when known."""

    def __init__(self, message: str, *, retry_after_s: float | None = None) -> None:
        """Record the failure and the upstream's retry hint, if any."""
        super().__init__("routing", message)
        self.retry_after_s = retry_after_s


class RoutingProvider(Protocol):
    """Finds route options between two points for a loaded truck."""

    name: str

    def route(
        self,
        origin: Coordinate,
        destination: Coordinate,
        *,
        load_weight_lb: int,
    ) -> RoutingResult:
        """Return the distinct routes from ``origin`` to ``destination``.

        ``load_weight_lb`` is the cargo weight; adapters add the tractor-trailer tare weight.

        Raises:
            NoRouteFoundError: the service found no route.
            ProviderError: any other provider failure (see :mod:`haulcast.providers.errors`).
        """
        ...
