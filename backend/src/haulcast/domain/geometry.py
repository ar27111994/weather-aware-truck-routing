"""Route geometry (DOMAIN-CONTRACT section 6): haversine distances, the path, positions on it.

A ``RoutePath`` is the provider's polyline as ``(lon, lat)`` WGS84 coordinates with, per
coordinate, the cumulative distance and travel time from the origin. Cumulative distance is the
haversine prefix sum (mean Earth radius 3958.7613 mi) linearly rescaled so the total equals the
provider's reported route length: displayed distance equals provider distance and per-checkpoint
attributions sum exactly to it.
"""

import math
from bisect import bisect_left
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
from typing import Final

from haulcast.domain.errors import InvalidPathError

EARTH_RADIUS_MI: Final = 3958.7613
"""Mean Earth radius in statute miles."""

_MAX_LATITUDE: Final = 90.0
_MAX_LONGITUDE: Final = 180.0
_FULL_TURN: Final = 360.0
_MIN_COORDINATES: Final = 2

Coordinate = tuple[float, float]
"""``(longitude, latitude)`` in WGS84 degrees (GeoJSON order)."""


def haversine_mi(a: Coordinate, b: Coordinate) -> float:
    """Return the great-circle distance in miles between two ``(lon, lat)`` points."""
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 2 * EARTH_RADIUS_MI * math.asin(math.sqrt(min(1.0, h)))


@dataclass(frozen=True, slots=True)
class RoutePath:
    """A validated route polyline with cumulative miles and seconds per coordinate.

    Invariants (checked on construction): at least two finite coordinates inside the WGS84
    ranges; ``cum_mi`` and ``cum_s`` align with them, are finite, start at 0 and never decrease;
    the total length is positive.
    """

    coords: tuple[Coordinate, ...]
    cum_mi: tuple[float, ...]
    cum_s: tuple[float, ...]

    def __post_init__(self) -> None:
        """Enforce the path invariants."""
        _check_coords(self.coords)
        if not len(self.cum_mi) == len(self.cum_s) == len(self.coords):
            raise InvalidPathError("cumulative arrays must align with the coordinates")
        _check_cumulative("cum_mi", self.cum_mi)
        _check_cumulative("cum_s", self.cum_s)
        if self.cum_mi[-1] <= 0:
            raise InvalidPathError("the path must have a positive length")

    @property
    def length_mi(self) -> float:
        """Total route length in miles (the provider's figure)."""
        return self.cum_mi[-1]

    @property
    def duration_s(self) -> float:
        """Total travel time in seconds."""
        return self.cum_s[-1]


def build_path(
    coords: Sequence[Coordinate], cum_s: Sequence[float], provider_length_mi: float
) -> RoutePath:
    """Build a path whose cumulative miles are rescaled to ``provider_length_mi``.

    Raises:
        InvalidPathError: The coordinates or times break the path invariants, the provider length
            is not a positive finite number, or every coordinate is the same point.
    """
    points = tuple((float(lon), float(lat)) for lon, lat in coords)
    _check_coords(points)
    if not (math.isfinite(provider_length_mi) and provider_length_mi > 0):
        raise InvalidPathError("the provider length must be a positive, finite number of miles")
    prefix = [0.0]
    total = 0.0
    for a, b in pairwise(points):
        total += haversine_mi(a, b)
        prefix.append(total)
    if total <= 0:
        raise InvalidPathError("all coordinates coincide: the path has no length")
    # Ratio first: d / total <= 1 exactly, so the rescaled values never exceed the provider
    # length and the last one equals it exactly.
    cum_mi = tuple((d / total) * provider_length_mi for d in prefix)
    return RoutePath(coords=points, cum_mi=cum_mi, cum_s=tuple(float(s) for s in cum_s))


def locate(path: RoutePath, distance_mi: float) -> tuple[Coordinate, float]:
    """Return the ``(lon, lat)`` position and elapsed seconds at ``distance_mi`` along the path.

    Position and time are interpolated linearly between the bracketing coordinates; longitude
    takes the short way across the antimeridian.

    Raises:
        InvalidPathError: ``distance_mi`` is not within ``[0, path.length_mi]``.
    """
    if not 0 <= distance_mi <= path.length_mi:
        raise InvalidPathError(
            f"distance {distance_mi!r} mi is outside the path [0, {path.length_mi}]"
        )
    after = bisect_left(path.cum_mi, distance_mi)
    if path.cum_mi[after] == distance_mi:
        return path.coords[after], path.cum_s[after]
    before = after - 1
    fraction = (distance_mi - path.cum_mi[before]) / (path.cum_mi[after] - path.cum_mi[before])
    (lon_a, lat_a), (lon_b, lat_b) = path.coords[before], path.coords[after]
    lon = _wrap(lon_a + fraction * _wrap(lon_b - lon_a))
    lat = lat_a + fraction * (lat_b - lat_a)
    elapsed = path.cum_s[before] + fraction * (path.cum_s[after] - path.cum_s[before])
    return (lon, lat), elapsed


def _wrap(longitude: float) -> float:
    """Bring a longitude (or longitude difference) back into ``[-180, 180]``."""
    if longitude > _MAX_LONGITUDE:
        return longitude - _FULL_TURN
    if longitude < -_MAX_LONGITUDE:
        return longitude + _FULL_TURN
    return longitude


def _check_coords(coords: Sequence[Coordinate]) -> None:
    if len(coords) < _MIN_COORDINATES:
        raise InvalidPathError("a path needs at least 2 coordinates")
    for lon, lat in coords:
        if not (math.isfinite(lon) and math.isfinite(lat)):
            raise InvalidPathError("coordinates must be finite")
        if not -_MAX_LATITUDE <= lat <= _MAX_LATITUDE:
            raise InvalidPathError(f"latitude {lat} is outside [-90, 90]")
        if not -_MAX_LONGITUDE <= lon <= _MAX_LONGITUDE:
            raise InvalidPathError(f"longitude {lon} is outside [-180, 180]")


def _check_cumulative(name: str, values: Sequence[float]) -> None:
    if not all(math.isfinite(value) for value in values):
        raise InvalidPathError(f"{name} values must be finite")
    if values[0] != 0:
        raise InvalidPathError(f"{name} must start at 0")
    if any(later < earlier for earlier, later in pairwise(values)):
        raise InvalidPathError(f"{name} must be non-decreasing")
