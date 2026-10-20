"""Display geometry of a route: Douglas-Peucker simplification and the checkpoint spans.

The response's ``geometry`` is not the provider's full-resolution polyline: a long route has tens
of thousands of vertices and the map needs only the ones that change what is drawn. Vertices
that deviate by at most :data:`SIMPLIFY_TOLERANCE_M` from the chord that replaces them are dropped
(Douglas-Peucker, about 15 m, invisible at any zoom a route fits on screen), the first and last
vertices always stay, and coordinates are rounded to five decimals (about 1.1 m).

Distances are measured in a flat frame local to the span being tested: longitude scaled by the
cosine of the span's mean latitude, which matches how the map draws a straight chord between two
vertices. ``cum_mi`` and ``cum_s`` of the kept vertices are copied from the full path, so they
stay aligned 1:1 with the simplified coordinates and exact at every vertex.

``checkpoint_spans`` then tells the risk ribbon which vertices each checkpoint paints. The spans
*partition* the polyline's segments in order: a segment belongs to the checkpoint whose owned
stretch contains the segment's midpoint (half-open, ``[lower, upper)``, the convention of the
heatmap cells too), consecutive spans share exactly one vertex (no gap, no overlap), a checkpoint
that owns no whole segment collapses onto the vertex its neighbours share, the first span starts
at vertex 0 and the last ends at the last vertex.
"""

import math
from bisect import bisect_right
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import accumulate
from typing import Final

from haulcast.domain import Coordinate, RoutePath

SIMPLIFY_TOLERANCE_M: Final = 15.0
"""Largest deviation, in metres, of a dropped vertex from the chord that replaces it."""

COORDINATE_DECIMALS: Final = 5
"""Decimals kept in displayed coordinates (about 1.1 m)."""

_METRES_PER_DEGREE: Final = 111_194.9266
"""Metres per degree of latitude on the mean-radius sphere (6,371,008.8 m * pi / 180)."""

_MIN_VERTICES: Final = 2


@dataclass(frozen=True, slots=True)
class DisplayGeometry:
    """The simplified polyline and its cumulative arrays, aligned 1:1 with ``coords``."""

    coords: tuple[Coordinate, ...]
    cum_mi: tuple[float, ...]
    cum_s: tuple[float, ...]


def simplify_path(path: RoutePath, tolerance_m: float = SIMPLIFY_TOLERANCE_M) -> DisplayGeometry:
    """Simplify ``path`` for display; the end points stay and cumulative values are copied."""
    kept = _kept_indices(path.coords, tolerance_m)
    return DisplayGeometry(
        coords=tuple(
            (
                round(path.coords[index][0], COORDINATE_DECIMALS),
                round(path.coords[index][1], COORDINATE_DECIMALS),
            )
            for index in kept
        ),
        cum_mi=tuple(path.cum_mi[index] for index in kept),
        cum_s=tuple(path.cum_s[index] for index in kept),
    )


def checkpoint_spans(
    cum_mi: Sequence[float], owned_mi: Sequence[float]
) -> tuple[tuple[int, int], ...]:
    """Return each checkpoint's ``(coord_start, coord_end)`` vertex range (inclusive).

    ``cum_mi`` is the simplified polyline's cumulative miles and ``owned_mi`` the miles each
    checkpoint owns (``Checkpoint.owned_mi``), in route order, summing to the route length.

    Raises:
        ValueError: The polyline has fewer than two vertices or there is no checkpoint.
    """
    if len(cum_mi) < _MIN_VERTICES or not owned_mi:
        raise ValueError(
            "spans need a polyline of at least two vertices and at least one checkpoint"
        )
    upper_bounds = list(accumulate(owned_mi))[:-1]
    segments = len(cum_mi) - 1
    spans: list[tuple[int, int]] = []
    segment = 0
    for checkpoint in range(len(owned_mi)):
        start = segment
        while (
            segment < segments
            and bisect_right(upper_bounds, (cum_mi[segment] + cum_mi[segment + 1]) / 2)
            == checkpoint
        ):
            segment += 1
        spans.append((start, segment))
    return tuple(spans)


def _kept_indices(coords: Sequence[Coordinate], tolerance_m: float) -> list[int]:
    """Douglas-Peucker without recursion: the indices of the vertices to keep, ascending."""
    last = len(coords) - 1
    keep = bytearray(len(coords))
    keep[0] = keep[last] = 1
    pending = [(0, last)]
    while pending:
        low, high = pending.pop()
        if high - low < _MIN_VERTICES:
            continue
        index, deviation_m = _farthest(coords, low, high)
        if deviation_m > tolerance_m:
            keep[index] = 1
            pending.append((low, index))
            pending.append((index, high))
    return [index for index, flag in enumerate(keep) if flag]


def _farthest(coords: Sequence[Coordinate], low: int, high: int) -> tuple[int, float]:
    """Return the vertex between ``low`` and ``high`` farthest from their chord, and its metres."""
    start_lon, start_lat = coords[low]
    end_lon, end_lat = coords[high]
    x_scale = math.cos(math.radians((start_lat + end_lat) / 2)) * _METRES_PER_DEGREE
    chord_x = (end_lon - start_lon) * x_scale
    chord_y = (end_lat - start_lat) * _METRES_PER_DEGREE
    chord_sq = chord_x * chord_x + chord_y * chord_y
    farthest, farthest_sq = low + 1, -1.0
    for index in range(low + 1, high):
        x = (coords[index][0] - start_lon) * x_scale
        y = (coords[index][1] - start_lat) * _METRES_PER_DEGREE
        along = (x * chord_x + y * chord_y) / chord_sq if chord_sq else 0.0
        if along <= 0.0:
            distance_sq = x * x + y * y
        elif along >= 1.0:
            distance_sq = (x - chord_x) ** 2 + (y - chord_y) ** 2
        else:
            distance_sq = (x * chord_y - y * chord_x) ** 2 / chord_sq
        if distance_sq > farthest_sq:
            farthest, farthest_sq = index, distance_sq
    return farthest, math.sqrt(farthest_sq)
