"""The heatmap grid: D-22 geometry, the corridor of about 25 mi around every route, <= 200 cells."""

import math
from collections.abc import Sequence
from itertools import pairwise

import pytest

from haulcast.domain import Coordinate, haversine_mi
from haulcast.providers.weather.base import LatticePoint
from haulcast.services.heatmap_grid import (
    CORRIDOR_RADIUS_MI,
    MAX_CELLS,
    HeatmapGrid,
    RouteLine,
    build_grid,
)

MI_PER_DEGREE_LAT = 69.09


def line(coords: Sequence[Coordinate]) -> RouteLine:
    """A route line over ``coords`` with haversine cumulative miles."""
    cum_mi = [0.0]
    for a, b in pairwise(coords):
        cum_mi.append(cum_mi[-1] + haversine_mi(a, b))
    return RouteLine(coords=tuple(coords), cum_mi=tuple(cum_mi))


def east_west(lat: float, lon_from: float, lon_to: float, points: int = 20) -> RouteLine:
    """A straight due-east line sampled at ``points`` vertices."""
    step = (lon_to - lon_from) / (points - 1)
    return line([(lon_from + step * index, lat) for index in range(points)])


def listed(grid: HeatmapGrid) -> set[tuple[int, int]]:
    """``(row, col)`` of every listed cell."""
    return {divmod(index, grid.cols) for index in grid.cells}


def dense(route: RouteLine, spacing_mi: float = 1.0) -> list[Coordinate]:
    """Points along ``route`` at most ``spacing_mi`` apart (the test's own oracle sampling)."""
    samples: list[Coordinate] = [route.coords[0]]
    for (a, b), (c0, c1) in zip(pairwise(route.coords), pairwise(route.cum_mi), strict=True):
        pieces = max(1, math.ceil((c1 - c0) / spacing_mi))
        samples.extend(
            (a[0] + (b[0] - a[0]) * k / pieces, a[1] + (b[1] - a[1]) * k / pieces)
            for k in range(1, pieces + 1)
        )
    return samples


def centre_of(grid: HeatmapGrid, row: int, col: int) -> Coordinate:
    """``(lon, lat)`` of the centre of cell ``(row, col)``, by the D-22 formulas."""
    return (grid.lon0 + (col + 0.5) * grid.dlon, grid.lat0 + (row + 0.5) * grid.dlat)


def cell_containing(grid: HeatmapGrid, position: Coordinate) -> tuple[int, int]:
    """The ``(row, col)`` whose half-open bounds contain ``position`` (D-22)."""
    lon, lat = position
    return (math.floor((lat - grid.lat0) / grid.dlat), math.floor((lon - grid.lon0) / grid.dlon))


def distance_to(routes: Sequence[RouteLine], position: Coordinate) -> float:
    """Miles from ``position`` to the nearest dense sample of any route."""
    return min(haversine_mi(position, sample) for route in routes for sample in dense(route))


# --------------------------------------------------------------------------- D-22 geometry


def test_the_origin_is_the_south_west_corner_rows_run_north_and_columns_east() -> None:
    """A 2 x 3 grid of 0.2 degree cells whose six cells are all different places."""
    grid = HeatmapGrid(
        step_e1=2,
        lat_centre0_e1=398,
        lon_centre0_e1=-1052,
        rows=2,
        cols=3,
        cells=(0, 1, 2, 3, 4, 5),
    )

    assert (grid.dlat, grid.dlon) == (0.2, 0.2)
    assert (grid.lat0, grid.lon0) == (39.7, -105.3)
    assert [grid.centre(index) for index in range(6)] == [
        LatticePoint(398, -1052),
        LatticePoint(398, -1050),
        LatticePoint(398, -1048),
        LatticePoint(400, -1052),
        LatticePoint(400, -1050),
        LatticePoint(400, -1048),
    ]


@pytest.mark.parametrize("step_e1", [2, 3, 4, 5])
def test_every_centre_lies_on_the_lattice_and_half_a_cell_from_the_origin(step_e1: int) -> None:
    grid = HeatmapGrid(
        step_e1=step_e1,
        lat_centre0_e1=step_e1 * 20,
        lon_centre0_e1=-step_e1 * 40,
        rows=3,
        cols=4,
        cells=tuple(range(12)),
    )

    for index in range(12):
        centre = grid.centre(index)
        lon, lat = centre_of(grid, *divmod(index, grid.cols))
        assert (lat, lon) == pytest.approx((centre.lat, centre.lon))


# --------------------------------------------------------------------------- the corridor


@pytest.fixture
def slc_to_denver() -> RouteLine:
    """A roughly 330 mile east-south-east line, like Salt Lake City to Denver."""
    return line([(-111.891 + 0.3 * index, 40.7608 - 0.05 * index) for index in range(21)])


def test_every_vertex_of_every_route_lies_inside_a_listed_cell(slc_to_denver: RouteLine) -> None:
    other = east_west(41.5, -111.9, -105.0)

    grid = build_grid([slc_to_denver, other])

    for route in (slc_to_denver, other):
        for position in dense(route, spacing_mi=0.5):
            assert cell_containing(grid, position) in listed(grid)


def test_the_corridor_is_every_cell_whose_centre_is_within_the_radius(
    slc_to_denver: RouteLine,
) -> None:
    grid = build_grid([slc_to_denver])

    cells = listed(grid)
    for row in range(-3, grid.rows + 3):
        for col in range(-3, grid.cols + 3):
            miles = distance_to([slc_to_denver], centre_of(grid, row, col))
            if miles <= CORRIDOR_RADIUS_MI - 0.5:
                assert (row, col) in cells, f"({row}, {col}) is {miles:.1f} mi away, not listed"
            if miles >= CORRIDOR_RADIUS_MI + 0.5:
                assert (row, col) not in cells, f"({row}, {col}) is {miles:.1f} mi away, listed"


def test_cells_are_strictly_ascending_row_major_indices_inside_the_grid(
    slc_to_denver: RouteLine,
) -> None:
    grid = build_grid([slc_to_denver])

    assert list(grid.cells) == sorted(set(grid.cells))
    assert grid.cells[0] >= 0
    assert grid.cells[-1] < grid.rows * grid.cols
    assert grid.cells[0] < grid.cols
    assert grid.cells[-1] >= (grid.rows - 1) * grid.cols


def test_a_corridor_that_fits_uses_the_finest_spacing() -> None:
    grid = build_grid([east_west(40.0, -105.0, -104.0)])

    assert grid.step_e1 == 2
    assert len(grid.cells) <= MAX_CELLS


def test_a_longer_corridor_gets_a_coarser_grid_to_stay_within_the_cell_budget(
    slc_to_denver: RouteLine,
) -> None:
    long_route = east_west(40.0, -122.0, -75.0, points=60)

    grid = build_grid([long_route, slc_to_denver])

    assert grid.step_e1 > 2
    assert len(grid.cells) <= MAX_CELLS


def test_the_spacing_chosen_is_the_finest_that_fits() -> None:
    routes = [east_west(40.0, -122.0, -75.0, points=60)]

    grid = build_grid(routes)

    assert len(grid.cells) <= MAX_CELLS
    for finer in range(2, grid.step_e1):
        too_big = build_grid(routes, steps_e1=(finer,), max_cells=10_000)
        assert len(too_big.cells) > MAX_CELLS


def test_when_even_the_coarsest_grid_is_too_big_the_nearest_cells_are_kept() -> None:
    """Three coast-to-coast lines make about 280 cells at 0.5 degrees: the 200 nearest remain."""
    near = east_west(39.1, -122.0, -76.0, points=50)
    routes = [east_west(31.2, -122.0, -76.0, points=50), near, east_west(47.3, -122.0, -76.0, 50)]

    grid = build_grid(routes)

    assert grid.step_e1 == 5
    assert len(grid.cells) == MAX_CELLS
    universe = build_grid(routes, steps_e1=(5,), max_cells=10_000)
    assert len(universe.cells) > MAX_CELLS
    kept = {grid.centre(index) for index in grid.cells}
    nearest = {
        universe.centre(index)
        for index in universe.cells
        if abs(universe.centre(index).lat - 39.1) * MI_PER_DEGREE_LAT < CORRIDOR_RADIUS_MI
    }
    assert nearest <= kept
    assert kept <= {universe.centre(index) for index in universe.cells}


def test_the_grid_is_deterministic(slc_to_denver: RouteLine) -> None:
    assert build_grid([slc_to_denver]) == build_grid([slc_to_denver])


def test_a_degenerate_one_vertex_route_still_gets_cells_around_it() -> None:
    grid = build_grid([RouteLine(coords=((-105.0, 40.0), (-105.0, 40.0)), cum_mi=(0.0, 0.0))])

    assert 1 <= len(grid.cells) <= MAX_CELLS


def test_building_a_grid_needs_a_route() -> None:
    with pytest.raises(ValueError, match="at least one route"):
        build_grid([])
