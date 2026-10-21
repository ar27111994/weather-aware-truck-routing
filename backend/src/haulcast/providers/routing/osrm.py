"""OSRM adapter for the public demo server: car routing, used for long hauls and as the fallback.

The demo server only has a **car** profile (``/route/v1/truck/...`` silently answers with the car
route), so nothing here is truck-restricted; the routing chain says so in a warning whenever it
serves a plan from this adapter. What the adapter does to stay honest and useful:

* ``annotations=duration,distance`` give an exact per-segment clock (no spreading needed). The
  annotated seconds omit turn and signal penalties that the route's own ``duration`` includes
  (0.33 % on the probed 520-mile route), so the clock is scaled to the route duration first.
* A truck is not a car: no stretch of road is driven faster than the configured top speed
  (default 105 km/h), so a segment the car profile drives faster is slowed down to the cap and the
  route duration becomes the capped total. Slower stretches keep their annotated time.
* OSRM often returns one or two alternatives (1 / 2 / 2 / 1 / 2 / 2 on the six trips probed) and
  has no way to force more (``exclude`` classes are unsupported), so the adapter filters out
  near-duplicates and reports fewer than three routes with a warning instead of padding.
* Routes carry the label ``Car route N``: at overview detail OSRM sends no road names, and
  requesting turn-by-turn steps would multiply a 1.4 MB response (Los Angeles to New York).
"""

from dataclasses import replace
from typing import Final

from haulcast.config.env import DEFAULT_TRUCK_TOP_SPEED_KPH
from haulcast.providers.errors import ProviderRejectedError
from haulcast.providers.http import QueryParams, UpstreamClient
from haulcast.providers.routing.base import (
    Coordinate,
    NoRouteFoundError,
    RouteOption,
    RoutingResult,
    fewer_routes_warning,
)
from haulcast.providers.routing.diversity import (
    DEFAULT_DIVERSITY,
    DiversityPolicy,
    distinct_routes,
)
from haulcast.providers.routing.parsing import Parser

PROVIDER_NAME: Final = "osrm"
OSRM_URL: Final = "https://router.project-osrm.org/route/v1/driving"
"""The profile is always ``driving``: it is a car profile whatever the path says."""

_PARAMS: Final[QueryParams] = {
    "alternatives": 3,
    "overview": "full",
    "geometries": "polyline6",
    "steps": "false",
    "annotations": "duration,distance",
}
_POLYLINE_PRECISION: Final = 6
_METERS_PER_MILE: Final = 1609.344
_KPH_TO_MPS: Final = 1000.0 / 3600.0
_NO_ROUTE_CODES: Final = frozenset({"NoRoute", "NoSegment"})
"""The codes OSRM answers when it cannot connect the points.

Its API documents every error as HTTP 400 and the live demo server was probed doing exactly that
(2026-10-21, Los Angeles to Honolulu: ``400 {"code": "NoRoute", ...}``, R2-05). The same codes in
a 2xx body stay accepted, for servers that answer them that way.
"""
_SCALE_RANGE: Final = (0.5, 2.0)
"""Plausible ratio of route duration to annotated seconds; outside it the data is refused."""

_PARSER: Final = Parser(PROVIDER_NAME)


def _waypoint(point: Coordinate) -> str:
    """Format ``(lon, lat)`` for the URL path: fixed notation, never an exponent."""
    return f"{point[0]:.6f},{point[1]:.6f}"


def _annotations(legs: object, segments: int) -> tuple[list[float], list[float]]:
    """Return the per-segment ``(durations, distances)`` of all legs, checked against the shape."""
    durations: list[float] = []
    distances: list[float] = []
    legs_list = _PARSER.sequence(legs, "route legs")
    if not legs_list:
        raise _PARSER.error("route has no legs")
    for raw in legs_list:
        leg = _PARSER.mapping(raw, "route leg")
        annotation = _PARSER.mapping(leg.get("annotation"), "leg annotation")
        durations.extend(
            _PARSER.number(value, "annotated duration")
            for value in _PARSER.sequence(annotation.get("duration"), "annotated durations")
        )
        distances.extend(
            _PARSER.number(value, "annotated distance")
            for value in _PARSER.sequence(annotation.get("distance"), "annotated distances")
        )
    if len(durations) != segments or len(distances) != segments:
        raise _PARSER.error("annotations do not match the route geometry")
    return durations, distances


def _clock(
    durations: list[float], distances: list[float], duration_s: float, top_speed_mps: float
) -> tuple[float, ...]:
    """Scale the annotated seconds to ``duration_s``, then slow segments down to the speed cap."""
    annotated = sum(durations)
    if annotated <= 0:
        raise _PARSER.error("annotated durations add up to nothing")
    scale = duration_s / annotated
    if not _SCALE_RANGE[0] <= scale <= _SCALE_RANGE[1]:
        raise _PARSER.error("annotated durations disagree with the route duration")
    elapsed = 0.0
    clock = [0.0]
    for seconds, metres in zip(durations, distances, strict=True):
        elapsed += max(seconds * scale, metres / top_speed_mps)
        clock.append(elapsed)
    return tuple(clock)


def _parse_route(raw: object, top_speed_mps: float) -> RouteOption:
    """Turn one OSRM route into a :class:`RouteOption` (the summary is filled in later)."""
    route = _PARSER.mapping(raw, "route")
    distance_m = _PARSER.number(route.get("distance"), "route distance")
    duration_s = _PARSER.number(route.get("duration"), "route duration")
    if distance_m <= 0 or duration_s <= 0:
        raise _PARSER.error("route has no length or no duration")
    coords = _PARSER.polyline(route.get("geometry"), "route geometry", _POLYLINE_PRECISION)
    durations, distances = _annotations(route.get("legs"), len(coords) - 1)
    clock = _clock(durations, distances, duration_s, top_speed_mps)
    return RouteOption(
        coords=coords,
        cum_s=clock,
        distance_mi=distance_m / _METERS_PER_MILE,
        duration_s=clock[-1],
        summary="",
    )


def _parse_routes(document: object, top_speed_mps: float) -> list[RouteOption]:
    """Return every route of an OSRM ``/route`` answer, refusing error codes and odd data."""
    root = _PARSER.mapping(document, "response")
    code = root.get("code")
    if code in _NO_ROUTE_CODES:
        raise NoRouteFoundError(PROVIDER_NAME, "no route between these places")
    if code != "Ok":
        raise _PARSER.error("unexpected response code")
    routes = _PARSER.sequence(root.get("routes"), "routes")
    if not routes:
        raise _PARSER.error("response holds no routes")
    return [_parse_route(raw, top_speed_mps) for raw in routes]


class OsrmProvider:
    """Car routing through the OSRM demo server, capped at the truck top speed."""

    name = PROVIDER_NAME

    def __init__(
        self,
        client: UpstreamClient,
        *,
        top_speed_kph: float = DEFAULT_TRUCK_TOP_SPEED_KPH,
        policy: DiversityPolicy = DEFAULT_DIVERSITY,
    ) -> None:
        """Bind the HTTP ``client`` (which spaces its attempts), the speed cap and the policy."""
        self._client = client
        self._top_speed_mps = top_speed_kph * _KPH_TO_MPS
        self._policy = policy

    def route(
        self,
        origin: Coordinate,
        destination: Coordinate,
        *,
        load_weight_lb: int,
    ) -> RoutingResult:
        """Return the distinct car routes from ``origin`` to ``destination``.

        ``load_weight_lb`` is accepted for the interface and ignored: a car profile knows nothing
        about weight.

        Raises:
            NoRouteFoundError: OSRM cannot connect the two points (its HTTP 400 ``NoRoute``).
            ProviderRejectedError: OSRM refused the query (any other HTTP 4xx).
            ProviderUnavailableError: timeout, 5xx or 429.
            ProviderResponseError: the answer is malformed or inconsistent.
        """
        del load_weight_lb
        try:
            document = self._client.get_json(
                f"{OSRM_URL}/{_waypoint(origin)};{_waypoint(destination)}", params=_PARAMS
            )
        except ProviderRejectedError as exc:
            if exc.code in _NO_ROUTE_CODES:
                raise NoRouteFoundError(PROVIDER_NAME, "no route between these places") from exc
            raise
        kept = distinct_routes(_parse_routes(document, self._top_speed_mps), self._policy)
        routes = tuple(
            replace(route, summary=f"Car route {number}") for number, route in enumerate(kept, 1)
        )
        warnings = (
            ()
            if len(routes) >= self._policy.target_routes
            else (fewer_routes_warning(len(routes)),)
        )
        return RoutingResult(PROVIDER_NAME, routes, warnings)
