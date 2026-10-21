"""Valhalla adapter for the FOSSGIS public server: truck routing with a guaranteed set of options.

``costing=truck`` with the loaded gross weight and the configured top speed; ``alternates=2`` (the
server maximum) asks for up to three routes, which is often not what comes back (3 / 3 / 2 / 1 / 1
on the five trips probed), so :meth:`ValhallaProvider.route` runs the *forced-diversity* search of
PROVIDERS.md Q2 whenever fewer than three distinct routes came back: it pushes the engine away
from the first route with a point (``exclude_locations``) or a small square
(``exclude_polygons``, a ring is capped at 10 km by the server) placed at fractions of its length,
one extra call per variant, until three distinct routes exist or the budget is spent.

Facts the adapter is built on (all probed, see PROVIDERS.md Q1):

* the shape is a precision-6 polyline in ``(lat, lon)`` order; maneuvers tile it exactly through
  ``begin_shape_index`` / ``end_shape_index``, so spreading each maneuver's time over its shape
  segments proportionally to their length gives a per-coordinate clock (DOMAIN-CONTRACT D-06);
* ``costing_options.truck.weight`` is metric tons and is **not** validated by the server, so it is
  clamped here; ``top_speed`` is km/h and changes the ranking of routes, so one value is used for
  every call of a trip (all routes are priced by the same cost model);
* ``date_time`` has no effect on the public server and is never sent; calls are strictly
  sequential and at least a second apart in one process (the operator's fair-use ask, kept by the
  client's per-attempt hook so a retry is spaced too), identified by ``User-Agent`` and
  ``X-Client-Id``.
"""

import re
import time
from collections.abc import Callable, Mapping
from itertools import pairwise
from typing import Final

from haulcast.config.env import DEFAULT_TRUCK_TOP_SPEED_KPH
from haulcast.providers.errors import (
    ProviderRejectedError,
    ProviderResponseError,
    ProviderUnavailableError,
)
from haulcast.providers.http import UpstreamClient
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
    is_distinct,
)
from haulcast.providers.routing.geometry import anchor_at_fraction, haversine_m
from haulcast.providers.routing.parsing import Parser

PROVIDER_NAME: Final = "valhalla"
VALHALLA_URL: Final = "https://valhalla1.openstreetmap.de/route"
CLIENT_ID: Final = "haulcast"
"""Sent as ``X-Client-Id``: the public server's operators ask apps to identify themselves."""


def client_headers() -> dict[str, str]:
    """Return the headers that identify this application to the public Valhalla server."""
    return {"X-Client-Id": CLIENT_ID}


TARE_WEIGHT_LB: Final = 35_000
"""Empty tractor-trailer (5-axle semi) weight; the cargo is added to it."""
MAX_TRUCK_WEIGHT_TONNES: Final = 50.0
NEUTRAL_LABEL: Final = "via local roads"
"""The via-label of a route whose maneuvers carry no street names."""

# Valhalla error codes meaning "there is no route": 442 was probed, 170/171 are its siblings for
# unconnected regions and "no suitable edges near location".
_NO_ROUTE_CODES: Final = frozenset({"170", "171", "442"})
_KG_PER_LB: Final = 0.45359237
_POLYLINE_PRECISION: Final = 6
_BASE_ALTERNATES: Final = 2
_TIME_TOLERANCE: Final = 0.05
"""Relative gap allowed between the maneuver times and the trip time before the data is refused."""
_VIA_NAMES: Final = 2
_MAX_NAME_CHARS: Final = 40
_CARDINALS: Final = frozenset({"east", "west", "north", "south"})
_ROUTE_DESIGNATOR: Final = re.compile(r"[A-Z]{1,3} \d{1,4}[A-Z]?")
_VARIANTS: Final = ("loc", "poly")
_PARSER: Final = Parser(PROVIDER_NAME)


def truck_weight_tonnes(load_weight_lb: int) -> float:
    """Return the gross weight (tare plus ``load_weight_lb``) in metric tons, clamped to 0..50.

    The server accepts any number without validating it, so the clamp keeps absurd inputs from
    silently disabling every weight restriction (or applying nonsense ones).
    """
    gross = (TARE_WEIGHT_LB + load_weight_lb) * _KG_PER_LB / 1000.0
    return round(min(max(gross, 0.0), MAX_TRUCK_WEIGHT_TONNES), 2)


def exclusion_ring(anchor: Coordinate, half_size_deg: float) -> tuple[Coordinate, ...]:
    """Return the closed square ring ``(lon, lat)`` of half-size ``half_size_deg`` at ``anchor``.

    Valhalla caps an ``exclude_polygons`` ring at 10,000 m of perimeter; 0.01 degrees stay below
    that at every latitude (about 8.9 km at the equator, less towards the poles).
    """
    lon, lat = anchor
    south_west = (lon - half_size_deg, lat - half_size_deg)
    south_east = (lon + half_size_deg, lat - half_size_deg)
    north_east = (lon + half_size_deg, lat + half_size_deg)
    north_west = (lon - half_size_deg, lat + half_size_deg)
    return (south_west, south_east, north_east, north_west, south_west)


def normalise_road_name(raw: str) -> str:
    """Turn a Valhalla street name into a short, tidy label (``I 25 South`` becomes ``I-25``).

    Control characters are dropped, whitespace collapsed and the length capped. Leading or
    trailing cardinal words are removed only when a route number remains (``East Highway 6``
    becomes ``Highway 6`` but ``North Avenue`` is left alone), and a short route designator is
    hyphenated (``US 40`` becomes ``US-40``).
    """
    words = "".join(char if char.isprintable() else " " for char in raw).split()
    while len(words) > 1 and words[0].lower() in _CARDINALS and _has_digit(words[1:]):
        words = words[1:]
    while len(words) > 1 and words[-1].lower() in _CARDINALS and _has_digit(words[:-1]):
        words = words[:-1]
    text = " ".join(words)
    if _ROUTE_DESIGNATOR.fullmatch(text):
        text = text.replace(" ", "-")
    return text[:_MAX_NAME_CHARS]


def _has_digit(words: list[str]) -> bool:
    return any(char.isdigit() for word in words for char in word)


def _cumulative_seconds(
    coords: tuple[Coordinate, ...], maneuvers: list[object], duration_s: float
) -> tuple[float, ...]:
    """Spread every maneuver's time over its shape segments; rescale to exactly ``duration_s``."""
    last = len(coords) - 1
    lengths = [haversine_m(a, b) for a, b in pairwise(coords)]
    elapsed = [0.0] * len(coords)
    clock_s = 0.0
    expected_begin = 0
    for raw in maneuvers:
        maneuver = _PARSER.mapping(raw, "maneuver")
        begin = _PARSER.index(maneuver.get("begin_shape_index"), "maneuver begin", last)
        end = _PARSER.index(maneuver.get("end_shape_index"), "maneuver end", last)
        time_s = _PARSER.number(maneuver.get("time"), "maneuver time")
        if begin != expected_begin or end < begin:
            raise _PARSER.error("maneuvers do not tile the route shape")
        span = lengths[begin:end]
        span_length = sum(span)
        spread = 0.0
        for offset, segment in enumerate(span):
            spread += time_s * (segment / span_length if span_length > 0 else 1 / len(span))
            elapsed[begin + offset + 1] = clock_s + spread
        clock_s += time_s
        expected_begin = end
    if expected_begin != last:
        raise _PARSER.error("maneuvers do not cover the route shape")
    if clock_s <= 0 or abs(clock_s - duration_s) > _TIME_TOLERANCE * duration_s:
        raise _PARSER.error("maneuver times do not add up to the trip time")
    scale = duration_s / clock_s
    scaled = [min(value * scale, duration_s) for value in elapsed]
    scaled[-1] = duration_s
    return tuple(scaled)


def _via_label(maneuvers: list[object]) -> str:
    """Label a route by the two roads it spends the most distance on (``via I-80, I-25``)."""
    miles: dict[str, float] = {}
    for raw in maneuvers:
        maneuver = _PARSER.mapping(raw, "maneuver")
        names = maneuver.get("street_names")
        if not isinstance(names, list) or not names or not isinstance(names[0], str):
            continue
        name = normalise_road_name(names[0])
        if name:
            miles[name] = miles.get(name, 0.0) + _PARSER.number(
                maneuver.get("length"), "maneuver length"
            )
    longest = sorted(miles, key=lambda name: -miles[name])[:_VIA_NAMES]
    return f"via {', '.join(longest)}" if longest else NEUTRAL_LABEL


def _parse_trip(trip: object) -> RouteOption:
    """Turn one Valhalla ``trip`` into a :class:`RouteOption`, refusing inconsistent data."""
    document = _PARSER.mapping(trip, "trip")
    summary = _PARSER.mapping(document.get("summary"), "trip summary")
    distance_mi = _PARSER.number(summary.get("length"), "trip length")
    duration_s = _PARSER.number(summary.get("time"), "trip time")
    if distance_mi <= 0 or duration_s <= 0:
        raise _PARSER.error("trip has no length or no duration")
    legs = _PARSER.sequence(document.get("legs"), "trip legs")
    if len(legs) != 1:
        raise _PARSER.error("expected exactly one route leg")
    leg = _PARSER.mapping(legs[0], "route leg")
    coords = _PARSER.polyline(leg.get("shape"), "route shape", _POLYLINE_PRECISION)
    maneuvers = _PARSER.sequence(leg.get("maneuvers"), "maneuvers")
    return RouteOption(
        coords=coords,
        cum_s=_cumulative_seconds(coords, maneuvers, duration_s),
        distance_mi=distance_mi,
        duration_s=duration_s,
        summary=_via_label(maneuvers),
    )


def _parse_routes(document: object) -> list[RouteOption]:
    """Return ``[trip] + alternates`` of a base response, each parsed and validated."""
    root = _PARSER.mapping(document, "response")
    trips = [root.get("trip")]
    alternates = root.get("alternates", [])
    trips.extend(
        _PARSER.mapping(item, "alternate").get("trip")
        for item in _PARSER.sequence(alternates, "alternates")
    )
    return [_parse_trip(trip) for trip in trips]


class ValhallaProvider:
    """Truck routing through Valhalla with a guaranteed search for three distinct routes."""

    name = PROVIDER_NAME

    def __init__(
        self,
        client: UpstreamClient,
        *,
        top_speed_kph: float = DEFAULT_TRUCK_TOP_SPEED_KPH,
        policy: DiversityPolicy = DEFAULT_DIVERSITY,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """Bind the HTTP ``client`` (it spaces its attempts), the cost model and the policy."""
        self._client = client
        self._top_speed_kph = top_speed_kph
        self._policy = policy
        self._clock = clock

    def route(
        self,
        origin: Coordinate,
        destination: Coordinate,
        *,
        load_weight_lb: int,
    ) -> RoutingResult:
        """Return up to three distinct truck routes from ``origin`` to ``destination``.

        Raises:
            NoRouteFoundError: Valhalla reports that no route connects the two points.
            ProviderRejectedError: Valhalla refused the trip (for example error 154, too far).
            ProviderUnavailableError: timeout, 5xx or 429 on the base call.
            ProviderResponseError: the base answer is malformed or inconsistent.
        """
        started = self._clock()
        body = self._body(origin, destination, load_weight_lb)
        try:
            document = self._post({**body, "alternates": _BASE_ALTERNATES, "id": "route"})
        except ProviderRejectedError as exc:
            if exc.code in _NO_ROUTE_CODES:
                raise NoRouteFoundError(PROVIDER_NAME, "no route between these places") from exc
            raise
        kept = distinct_routes(_parse_routes(document), self._policy)
        if len(kept) < self._policy.target_routes:
            self._search_for_more(body, kept, started)
        warnings = (
            () if len(kept) >= self._policy.target_routes else (fewer_routes_warning(len(kept)),)
        )
        return RoutingResult(PROVIDER_NAME, tuple(kept), warnings)

    def _body(
        self, origin: Coordinate, destination: Coordinate, load_weight_lb: int
    ) -> dict[str, object]:
        """The request every call of a trip shares: same points, same cost model."""
        return {
            "locations": [
                {"lat": origin[1], "lon": origin[0]},
                {"lat": destination[1], "lon": destination[0]},
            ],
            "costing": "truck",
            "costing_options": {
                "truck": {
                    "weight": truck_weight_tonnes(load_weight_lb),
                    "top_speed": self._top_speed_kph,
                }
            },
            "directions_options": {"units": "miles", "language": "en-US"},
        }

    def _post(self, body: Mapping[str, object]) -> object:
        """Send one request (the client spaces and charges every attempt, retries included)."""
        return self._client.post_json(
            VALHALLA_URL, body=body, headers=client_headers(), idempotent=True
        )

    def _search_for_more(
        self, body: dict[str, object], kept: list[RouteOption], started: float
    ) -> None:
        """Forced diversity: add routes to ``kept`` until the target, budget or clock ends it."""
        policy = self._policy
        deadline = started + policy.stage_budget_s
        extra_calls = 0
        try:
            for fraction in policy.anchor_fractions:
                anchor = anchor_at_fraction(kept[0].coords, fraction)
                for variant in _VARIANTS:
                    if (
                        len(kept) >= policy.target_routes
                        or extra_calls >= policy.max_extra_calls
                        or self._clock() >= deadline
                    ):
                        return
                    extra_calls += 1
                    candidate = self._forced_route(body, variant, anchor)
                    if candidate is not None and is_distinct(candidate, kept, policy):
                        kept.append(candidate)
                        break
        except ProviderUnavailableError:
            return  # a struggling server is not hammered with more variants

    def _forced_route(
        self, body: dict[str, object], variant: str, anchor: Coordinate
    ) -> RouteOption | None:
        """Ask for a route that avoids ``anchor``; ``None`` if the answer is unusable.

        Raises:
            ProviderUnavailableError: timeout, 5xx or 429 (the caller stops the search).
        """
        if variant == "loc":
            exclusion: dict[str, object] = {
                "exclude_locations": [{"lat": anchor[1], "lon": anchor[0]}]
            }
        else:
            ring = exclusion_ring(anchor, self._policy.polygon_half_size_deg)
            exclusion = {"exclude_polygons": [[[lon, lat] for lon, lat in ring]]}
        try:
            document = self._post({**body, "id": "force", **exclusion})
            return _parse_trip(_PARSER.mapping(document, "response").get("trip"))
        except (ProviderRejectedError, ProviderResponseError):
            return None
