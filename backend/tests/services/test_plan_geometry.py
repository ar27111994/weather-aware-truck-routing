"""Display geometry: Douglas-Peucker simplification and the checkpoint spans."""

import math
from itertools import accumulate, pairwise

import pytest
from hypothesis import assume, given
from hypothesis import strategies as st

from haulcast.domain import Coordinate, RoutePath, build_path, haversine_mi
from haulcast.services.plan_geometry import (
    COORDINATE_DECIMALS,
    SIMPLIFY_TOLERANCE_M,
    checkpoint_spans,
    simplify_path,
)

M_PER_DEGREE_LAT = 111_194.9266
ROUNDING_SLACK_M = 2.5
"""Coordinates are rounded to 5 decimals (about 1.1 m) after the tolerance test."""


def path_of(coords: list[Coordinate]) -> RoutePath:
    """A path over ``coords`` taking a minute per leg; its length is the haversine total."""
    length = sum(haversine_mi(a, b) for a, b in pairwise(coords))
    return build_path(coords, [60.0 * index for index in range(len(coords))], length)


def distance_to_segment_m(point: Coordinate, start: Coordinate, end: Coordinate) -> float:
    """Planar distance in metres from ``point`` to the segment, in a frame local to the segment.

    An independent oracle for the implementation: it projects around the segment's own mean
    latitude and measures with the cross product, where the implementation projects per span and
    measures with a dot-product clamp.
    """
    scale = math.cos(math.radians((start[1] + end[1]) / 2)) * M_PER_DEGREE_LAT

    def local(position: Coordinate) -> tuple[float, float]:
        return (position[0] - start[0]) * scale, (position[1] - start[1]) * M_PER_DEGREE_LAT

    px, py = local(point)
    ex, ey = local(end)
    length_sq = ex * ex + ey * ey
    if length_sq == 0:
        return math.hypot(px, py)
    share = max(0.0, min(1.0, (px * ex + py * ey) / length_sq))
    return math.hypot(px - share * ex, py - share * ey)


# --------------------------------------------------------------------------- simplification


def test_collinear_points_collapse_to_the_end_points() -> None:
    coords = [(-105.0 + 0.01 * index, 40.0) for index in range(11)]

    geometry = simplify_path(path_of(coords))

    assert geometry.coords == ((-105.0, 40.0), (-104.9, 40.0))


def test_a_corner_is_kept() -> None:
    coords = [
        (-105.0, 40.0),
        (-104.95, 40.0),
        (-104.9, 40.0),
        (-104.9, 40.05),
        (-104.9, 40.1),
    ]

    geometry = simplify_path(path_of(coords))

    assert geometry.coords == ((-105.0, 40.0), (-104.9, 40.0), (-104.9, 40.1))


@pytest.mark.parametrize(
    ("bump_m", "kept"),
    [(10.0, 2), (14.0, 2), (16.0, 3), (20.0, 3)],
)
def test_a_bump_is_kept_only_when_it_exceeds_the_tolerance(bump_m: float, kept: int) -> None:
    middle = (-104.95, 40.0 + bump_m / M_PER_DEGREE_LAT)

    geometry = simplify_path(path_of([(-105.0, 40.0), middle, (-104.9, 40.0)]))

    assert SIMPLIFY_TOLERANCE_M == 15.0
    assert len(geometry.coords) == kept


def test_a_custom_tolerance_changes_what_is_kept() -> None:
    middle = (-104.95, 40.0 + 20.0 / M_PER_DEGREE_LAT)
    path = path_of([(-105.0, 40.0), middle, (-104.9, 40.0)])

    assert len(simplify_path(path, tolerance_m=25.0).coords) == 2
    assert len(simplify_path(path, tolerance_m=5.0).coords) == 3


def test_a_two_point_path_keeps_both_points() -> None:
    geometry = simplify_path(path_of([(-105.0, 40.0), (-104.0, 41.0)]))

    assert geometry.coords == ((-105.0, 40.0), (-104.0, 41.0))
    assert geometry.cum_mi[0] == 0.0


def test_a_loop_that_returns_to_its_start_keeps_the_far_point() -> None:
    """The chord of a closed loop is a point: distance to it is measured, not to a line."""
    coords = [(-105.0, 40.0), (-104.9, 40.0), (-104.9, 40.1), (-105.0, 40.1), (-105.0, 40.0)]

    geometry = simplify_path(path_of(coords))

    assert len(geometry.coords) >= 4
    assert geometry.coords[0] == geometry.coords[-1]


def test_coordinates_are_rounded_to_five_decimals() -> None:
    geometry = simplify_path(path_of([(-104.98486213, 39.73923644), (-111.89099111, 40.76080099)]))

    assert COORDINATE_DECIMALS == 5
    assert geometry.coords == ((-104.98486, 39.73924), (-111.89099, 40.7608))


def test_cumulative_arrays_belong_to_the_kept_vertices() -> None:
    coords = [
        (-105.0, 40.0),
        (-104.95, 40.0),
        (-104.9, 40.0),
        (-104.9, 40.05),
        (-104.9, 40.1),
    ]
    path = path_of(coords)

    geometry = simplify_path(path)

    kept = (0, 2, 4)
    assert geometry.cum_mi == tuple(path.cum_mi[index] for index in kept)
    assert geometry.cum_s == tuple(path.cum_s[index] for index in kept)
    assert geometry.cum_mi[0] == 0.0
    assert geometry.cum_mi[-1] == path.length_mi
    assert geometry.cum_s == (0.0, 120.0, 240.0)


@given(
    start=st.tuples(st.floats(-120, -75), st.floats(25, 48)),
    steps=st.lists(st.tuples(st.integers(-20, 20), st.integers(-20, 20)), min_size=1, max_size=40),
)
def test_every_dropped_vertex_stays_within_the_tolerance_of_the_simplified_line(
    start: tuple[float, float], steps: list[tuple[int, int]]
) -> None:
    assume(any(dx or dy for dx, dy in steps))
    coords = [start]
    for dx, dy in steps:
        lon, lat = coords[-1]
        coords.append((lon + dx * 0.001, lat + dy * 0.001))
    assume(all(a != b for a, b in pairwise(coords)))
    path = path_of(coords)

    geometry = simplify_path(path)

    assert geometry.coords[0] == tuple(round(value, 5) for value in coords[0])
    assert geometry.coords[-1] == tuple(round(value, 5) for value in coords[-1])
    assert geometry.cum_mi[0] == 0.0
    assert geometry.cum_mi[-1] == path.length_mi
    assert all(later >= earlier for earlier, later in pairwise(geometry.cum_mi))
    kept = [path.cum_mi.index(value) for value in geometry.cum_mi]
    assert kept == sorted(set(kept))
    for low, high in pairwise(kept):
        for between in range(low + 1, high):
            offset = distance_to_segment_m(coords[between], coords[low], coords[high])
            assert offset <= SIMPLIFY_TOLERANCE_M + ROUNDING_SLACK_M


# --------------------------------------------------------------------------- checkpoint spans


def test_each_checkpoint_gets_the_vertices_of_the_stretch_it_owns() -> None:
    """Checkpoints at 0, 10, 20, 30 and 40 mi own [0, 5), [5, 15), [15, 25), [25, 35), [35, 40]."""
    cum_mi = [float(mile) for mile in range(0, 41, 2)]
    owned_mi = [5.0, 10.0, 10.0, 10.0, 5.0]

    spans = checkpoint_spans(cum_mi, owned_mi)

    assert spans == ((0, 2), (2, 7), (7, 12), (12, 17), (17, 20))


def test_a_checkpoint_that_owns_no_whole_segment_collapses_onto_a_shared_vertex() -> None:
    """With vertices only at the checkpoints, a segment's midpoint is exactly a boundary."""
    cum_mi = [0.0, 10.0, 20.0, 30.0, 40.0]
    owned_mi = [5.0, 10.0, 10.0, 10.0, 5.0]

    spans = checkpoint_spans(cum_mi, owned_mi)

    assert spans == ((0, 0), (0, 1), (1, 2), (2, 3), (3, 4))


def test_a_long_segment_belongs_to_the_checkpoint_around_its_midpoint() -> None:
    """One 100 mi segment: only the checkpoint owning mile 50 paints it; the others collapse."""
    cum_mi = [0.0, 100.0]
    owned_mi = [12.5, 25.0, 25.0, 25.0, 12.5]

    spans = checkpoint_spans(cum_mi, owned_mi)

    assert spans == ((0, 0), (0, 0), (0, 1), (1, 1), (1, 1))


def test_a_single_checkpoint_owns_the_whole_polyline() -> None:
    assert checkpoint_spans([0.0, 3.0, 9.0], [9.0]) == ((0, 2),)


@pytest.mark.parametrize(
    ("cum_mi", "owned_mi"),
    [([0.0], [1.0]), ([0.0, 1.0], [])],
)
def test_spans_need_a_segment_and_a_checkpoint(cum_mi: list[float], owned_mi: list[float]) -> None:
    with pytest.raises(ValueError, match="at least"):
        checkpoint_spans(cum_mi, owned_mi)


@given(
    gaps=st.lists(st.floats(0.1, 30.0), min_size=1, max_size=60),
    shares=st.lists(st.floats(0.1, 40.0), min_size=1, max_size=20),
)
def test_spans_partition_the_polyline_in_order(gaps: list[float], shares: list[float]) -> None:
    cum_mi = [0.0, *accumulate(gaps)]
    scale = cum_mi[-1] / sum(shares)
    owned_mi = [share * scale for share in shares]

    spans = checkpoint_spans(cum_mi, owned_mi)

    assert len(spans) == len(owned_mi)
    assert spans[0][0] == 0
    assert spans[-1][1] == len(cum_mi) - 1
    assert all(start <= end for start, end in spans)
    assert all(next_start == end for (_, end), (next_start, _) in pairwise(spans))
    bounds = [0.0, *accumulate(owned_mi)]
    for index, (start, end) in enumerate(spans):
        for segment in range(start, end):
            midpoint = (cum_mi[segment] + cum_mi[segment + 1]) / 2
            assert bounds[index] <= midpoint
            assert index == len(spans) - 1 or midpoint < bounds[index + 1]
