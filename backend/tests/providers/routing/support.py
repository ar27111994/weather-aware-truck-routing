"""Shared helpers for the routing tests: reference polyline encoder and recorded-fixture loading."""

import json
from collections.abc import Sequence
from dataclasses import dataclass
from functools import cache
from pathlib import Path

import httpx

from haulcast.providers.routing.base import Coordinate
from haulcast.providers.routing.polyline import decode_polyline

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "providers" / "routing"
"""Real upstream recordings (see ``README.md`` there for provenance)."""

_CONTINUATION_BIT = 0x20
_CHUNK_MASK = 0x1F
_ASCII_OFFSET = 63


def fixture_bytes(name: str) -> bytes:
    """Return the raw bytes of the recorded fixture ``name``."""
    return (FIXTURES / name).read_bytes()


def fixture_json(name: str) -> object:
    """Return the decoded JSON of the recorded fixture ``name``."""
    return json.loads(fixture_bytes(name))


def dig(document: object, *path: str | int) -> object:
    """Walk ``path`` (object keys and list indexes) into a decoded JSON document."""
    node = document
    for step in path:
        if isinstance(step, str):
            if not isinstance(node, dict):
                raise TypeError(f"expected an object before {step!r}, found {type(node).__name__}")
            node = node[step]
        else:
            if not isinstance(node, list):
                raise TypeError(f"expected a list before [{step}], found {type(node).__name__}")
            node = node[step]
    return node


def lonlat(points: Sequence[tuple[float, float]]) -> tuple[Coordinate, ...]:
    """Swap polyline ``(lat, lon)`` pairs into the package's ``(lon, lat)`` order."""
    return tuple((lon, lat) for lat, lon in points)


def valhalla_route_coords(name: str, index: int = 0) -> tuple[Coordinate, ...]:
    """Return route ``index`` (0 is ``trip``, then each alternate) of a recorded response."""
    document = fixture_json(name)
    trip = dig(document, "trip") if index == 0 else dig(document, "alternates", index - 1, "trip")
    shape = dig(trip, "legs", 0, "shape")
    if not isinstance(shape, str):
        raise TypeError("recorded Valhalla shape is not a string")
    return lonlat(decode_polyline(shape, 6))


class FakeClock:
    """A controllable monotonic clock whose ``sleep`` advances time instantly.

    Pass the instance as ``clock`` and its :meth:`sleep` as ``sleep`` so that code which waits
    runs without waiting, and the waits it asked for are recorded in :attr:`sleeps`.
    """

    def __init__(self, start: float = 1000.0) -> None:
        self.now = start
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def _encode_value(value: int) -> str:
    zigzag = ~(value << 1) if value < 0 else value << 1
    chars: list[str] = []
    while zigzag >= _CONTINUATION_BIT:
        chars.append(chr((_CONTINUATION_BIT | (zigzag & _CHUNK_MASK)) + _ASCII_OFFSET))
        zigzag >>= 5
    chars.append(chr(zigzag + _ASCII_OFFSET))
    return "".join(chars)


def encode_polyline(points: Sequence[tuple[float, float]], precision: int) -> str:
    """Encode ``(lat, lon)`` pairs with the Google polyline algorithm.

    An independent reference implementation, so the decoder is tested against its inverse
    rather than against itself.
    """
    factor = 10**precision
    previous_lat = previous_lon = 0
    parts: list[str] = []
    for lat, lon in points:
        scaled_lat, scaled_lon = round(lat * factor), round(lon * factor)
        parts.append(_encode_value(scaled_lat - previous_lat))
        parts.append(_encode_value(scaled_lon - previous_lon))
        previous_lat, previous_lon = scaled_lat, scaled_lon
    return "".join(parts)


def as_dict(value: object) -> dict[str, object]:
    """Narrow a decoded JSON value to an object (test fixtures are trusted to be well-formed)."""
    if not isinstance(value, dict):
        raise TypeError(f"expected an object, found {type(value).__name__}")
    return value


def json_response(name: str, status: int = 200) -> httpx.Response:
    """Answer as the upstream did when the fixture ``name`` was recorded."""
    return httpx.Response(
        status, content=fixture_bytes(name), headers={"content-type": "application/json"}
    )


@dataclass(frozen=True, slots=True)
class RecordedForcedCall:
    """One recorded forced-diversity call: which exclusion was sent and which file answered."""

    fixture: str
    variant: str
    """``loc`` (``exclude_locations``) or ``poly`` (``exclude_polygons``)."""
    lat: float
    lon: float
    """The anchor: the excluded point, or the centre of the excluded square."""


def exclusion_of(body: dict[str, object]) -> tuple[str, float, float]:
    """Return ``(variant, lat, lon)`` of the exclusion in a forced Valhalla request body."""
    if "exclude_locations" in body:
        locations = body["exclude_locations"]
        if not isinstance(locations, list):
            raise TypeError("exclude_locations must be a list")
        point = as_dict(locations[0])
        lat, lon = point["lat"], point["lon"]
        if not isinstance(lat, float | int) or not isinstance(lon, float | int):
            raise TypeError("exclude_locations entries need numeric lat/lon")
        return "loc", float(lat), float(lon)
    polygons = body["exclude_polygons"]
    if not isinstance(polygons, list) or not isinstance(polygons[0], list):
        raise TypeError("exclude_polygons must be a list of rings")
    ring = [point for point in polygons[0] if isinstance(point, list)]
    lons = [float(point[0]) for point in ring]
    lats = [float(point[1]) for point in ring]
    return "poly", (min(lats) + max(lats)) / 2, (min(lons) + max(lons)) / 2


@cache
def recorded_forced_calls() -> tuple[RecordedForcedCall, ...]:
    """Every ``valhalla-force-*`` recording with the exclusion its request carried (INDEX.json)."""
    index = as_dict(fixture_json("INDEX.json"))
    found: list[RecordedForcedCall] = []
    for name, entry in index.items():
        if not name.startswith("valhalla-force-"):
            continue
        body = as_dict(as_dict(as_dict(entry)["request"])["json"])
        variant, lat, lon = exclusion_of(body)
        found.append(RecordedForcedCall(name, variant, lat, lon))
    return tuple(found)
