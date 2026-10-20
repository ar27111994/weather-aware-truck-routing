"""Pure geometry for routes: great-circle distances, resampling, overlap and anchor points.

Coordinates are ``(longitude, latitude)`` degrees, the package-wide order (see ``Coordinate``).
Segments are interpolated linearly in longitude and latitude, so routes must not cross the
antimeridian; the routing upstreams are only used for places far from it.

The overlap definition is the one the 0.80 distinctness threshold and the forced-diversity
strategy were calibrated with (PROVIDERS.md Q2): the share of route ``a`` whose sample points lie
within a tolerance of route ``b``'s sample points. Chicago to Denver sits at 0.796 / 0.798 against
that threshold, so the details of the sampling are part of the contract and are pinned by tests
against the real recorded responses.
"""

import math
from bisect import bisect_left
from collections.abc import Iterable, Sequence
from itertools import accumulate, pairwise
from typing import Final

from haulcast.providers.routing.base import Coordinate

EARTH_RADIUS_MI: Final = 3958.7613
"""Mean Earth radius in miles (DOMAIN-CONTRACT D-06); every distance here derives from it."""

_KM_PER_MILE: Final = 1.609344
_EARTH_RADIUS_KM: Final = EARTH_RADIUS_MI * _KM_PER_MILE
_EARTH_RADIUS_M: Final = _EARTH_RADIUS_KM * 1000.0
_FULL_CIRCLE_DEG: Final = 360.0
_QUARTER_CIRCLE_DEG: Final = 90.0
_MIN_ANCHOR_COORDINATES: Final = 2
_CELL_RADII: Final = 2
"""Grid cell edge in radii: at least 1 for completeness; larger cells mean fewer, fuller cells."""
_NEIGHBOURHOOD: Final = (
    (0, 0),
    (1, 0),
    (-1, 0),
    (0, 1),
    (0, -1),
    (1, 1),
    (1, -1),
    (-1, 1),
    (-1, -1),
)
"""Offsets of the 3 x 3 block of grid cells around a point, its own cell first (most hits)."""


def _central_angle(
    lat_a: float, lat_b: float, cos_a: float, cos_b: float, delta_lon: float
) -> float:
    """Return the angle between two points seen from the Earth's centre (inputs in radians).

    ``cos_a`` and ``cos_b`` are the cosines of the latitudes, passed in so that callers walking a
    polyline compute each of them once per vertex instead of once per segment.
    """
    half_lat = (lat_b - lat_a) / 2
    half_lon = delta_lon / 2
    haversine = math.sin(half_lat) ** 2 + cos_a * cos_b * math.sin(half_lon) ** 2
    return 2 * math.asin(math.sqrt(min(1.0, haversine)))


def _pair_angle(a: Coordinate, b: Coordinate) -> float:
    """Return the central angle in radians between two ``(lon, lat)`` degree coordinates."""
    lat_a, lat_b = math.radians(a[1]), math.radians(b[1])
    return _central_angle(lat_a, lat_b, math.cos(lat_a), math.cos(lat_b), math.radians(b[0] - a[0]))


def _segment_lengths_m(coords: Sequence[Coordinate]) -> list[float]:
    """Return the great-circle length in metres of every segment of the polyline."""
    lons = [math.radians(lon) for lon, _ in coords]
    lats = [math.radians(lat) for _, lat in coords]
    cosines = [math.cos(lat) for lat in lats]
    return [
        _central_angle(lat_a, lat_b, cos_a, cos_b, lon_b - lon_a) * _EARTH_RADIUS_M
        for lon_a, lon_b, lat_a, lat_b, cos_a, cos_b in zip(
            lons, lons[1:], lats, lats[1:], cosines, cosines[1:], strict=False
        )
    ]


def haversine_mi(a: Coordinate, b: Coordinate) -> float:
    """Return the great-circle distance between ``a`` and ``b`` in miles."""
    return _pair_angle(a, b) * EARTH_RADIUS_MI


def haversine_km(a: Coordinate, b: Coordinate) -> float:
    """Return the great-circle distance between ``a`` and ``b`` in kilometres."""
    return _pair_angle(a, b) * _EARTH_RADIUS_KM


def haversine_m(a: Coordinate, b: Coordinate) -> float:
    """Return the great-circle distance between ``a`` and ``b`` in metres."""
    return _pair_angle(a, b) * _EARTH_RADIUS_M


def great_circle_km(origin: Coordinate, destination: Coordinate) -> float:
    """Return the crow-flies distance in kilometres, as the upstream's range limits measure it."""
    return haversine_km(origin, destination)


def densify(coords: Sequence[Coordinate], step_m: float) -> tuple[Coordinate, ...]:
    """Resample a polyline so that consecutive points are about ``step_m`` metres apart.

    A segment of length ``d`` is cut into ``max(1, floor(d / step_m))`` equal parts, linearly in
    longitude and latitude, and every input vertex is kept as it is. Consecutive samples are thus
    at least ``step_m`` apart (closer only on segments shorter than ``step_m``) and less than
    ``2 * step_m`` apart. This is the research reference's definition: cutting into
    ``ceil(d / step_m)`` parts instead would move Chicago to Denver across the distinctness
    threshold.

    Raises:
        ValueError: ``step_m`` is not positive.
    """
    if not step_m > 0:
        raise ValueError("step_m must be positive")
    if not coords:
        return ()
    dense: list[Coordinate] = [coords[0]]
    for (start, end), length in zip(pairwise(coords), _segment_lengths_m(coords), strict=True):
        parts = max(1, int(length // step_m))
        for part in range(1, parts):
            fraction = part / parts
            dense.append(
                (
                    start[0] + (end[0] - start[0]) * fraction,
                    start[1] + (end[1] - start[1]) * fraction,
                )
            )
        dense.append(end)
    return tuple(dense)


class _ProximityIndex:
    """Answers "is any indexed point within the radius of here?" without scanning them all.

    Points are bucketed into grid cells two radii wide in both directions, so every point within
    the radius of a query lies in the 3 x 3 block around the query's cell, and a set of the cells
    whose block holds anything lets a query far from every point be rejected with one lookup.
    The cell height is in degrees of latitude; the width is two radii of longitude at the highest
    latitude that can hold a neighbour (the highest indexed latitude plus the radius), which keeps
    the index complete towards the poles, where a degree of longitude gets shorter. Distances use
    the local equirectangular metric, accurate to millimetres at these scales.
    """

    def __init__(self, points: Sequence[Coordinate], radius_m: float) -> None:
        """Index ``points`` for neighbour queries within ``radius_m`` metres."""
        radius = math.degrees(radius_m / _EARTH_RADIUS_M)
        self._radius_squared = radius * radius
        self._cell_height = _CELL_RADII * radius
        highest = max(abs(lat) for _, lat in points) + radius
        self._cell_width = min(
            _FULL_CIRCLE_DEG,
            self._cell_height / math.cos(math.radians(min(highest, _QUARTER_CIRCLE_DEG))),
        )
        cells: dict[tuple[int, int], list[Coordinate]] = {}
        for point in points:
            key = (
                math.floor(point[0] / self._cell_width),
                math.floor(point[1] / self._cell_height),
            )
            bucket = cells.get(key)
            if bucket is None:
                cells[key] = [point]
            else:
                bucket.append(point)
        self._cells = cells
        self._reachable = {
            (column + step_column, row + step_row)
            for column, row in cells
            for step_column, step_row in _NEIGHBOURHOOD
        }

    def has_neighbour(self, lon: float, lat: float) -> bool:
        """Return whether an indexed point lies within the radius of ``(lon, lat)`` degrees."""
        column = math.floor(lon / self._cell_width)
        row = math.floor(lat / self._cell_height)
        if (column, row) not in self._reachable:
            return False
        east_scale = math.cos(math.radians(lat))
        for step_column, step_row in _NEIGHBOURHOOD:
            bucket = self._cells.get((column + step_column, row + step_row))
            if bucket is None:
                continue
            for other_lon, other_lat in bucket:
                east = (other_lon - lon) * east_scale
                north = other_lat - lat
                if east * east + north * north <= self._radius_squared:
                    return True
        return False


def overlap_fraction(
    a: Sequence[Coordinate],
    b: Sequence[Coordinate],
    *,
    tolerance_m: float = 250.0,
    step_m: float = 100.0,
) -> float:
    """Return the share of route ``a`` that lies within ``tolerance_m`` of route ``b``.

    Both routes are resampled with :func:`densify` at ``step_m``; the result is the fraction of
    ``a``'s samples that have a sample of ``b`` within ``tolerance_m``. It is one-directional: a
    route driving entirely along a longer one overlaps it fully, not the other way round.

    Raises:
        ValueError: a route has no coordinates, or ``tolerance_m`` / ``step_m`` is not positive.
    """
    if not tolerance_m > 0:
        raise ValueError("tolerance_m must be positive")
    if not a or not b:
        raise ValueError("route has no coordinates")
    dense_a = densify(a, step_m)
    index = _ProximityIndex(densify(b, step_m), tolerance_m)
    near = sum(1 for lon, lat in dense_a if index.has_neighbour(lon, lat))
    return near / len(dense_a)


def is_distinct_route(
    candidate: Sequence[Coordinate],
    kept: Iterable[Sequence[Coordinate]],
    *,
    threshold: float,
    tolerance_m: float,
    step_m: float,
) -> bool:
    """Return whether ``candidate`` overlaps each ``kept`` route by less than ``threshold``."""
    return all(
        overlap_fraction(candidate, route, tolerance_m=tolerance_m, step_m=step_m) < threshold
        for route in kept
    )


def anchor_at_fraction(coords: Sequence[Coordinate], fraction: float) -> Coordinate:
    """Return the vertex of the route that starts the segment reaching ``fraction`` of its length.

    Walking the route by cumulative great-circle length, the anchor is the start of the first
    segment whose end lies at or beyond ``fraction`` of the total. It is always one of ``coords``.

    Raises:
        ValueError: fewer than two coordinates, or ``fraction`` is outside ``[0, 1]``.
    """
    if len(coords) < _MIN_ANCHOR_COORDINATES:
        raise ValueError("at least two coordinates are needed to place an anchor")
    if not 0.0 <= fraction <= 1.0:
        raise ValueError("fraction must be between 0 and 1")
    reached = list(accumulate(_segment_lengths_m(coords)))
    return coords[bisect_left(reached, fraction * reached[-1])]
