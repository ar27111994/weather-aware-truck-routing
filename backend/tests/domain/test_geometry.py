"""Route geometry (DOMAIN-CONTRACT section 6): haversine, provider-length rescale, locate."""

import math

import pytest

from haulcast.domain import (
    EARTH_RADIUS_MI,
    InvalidPathError,
    RoutePath,
    build_path,
    haversine_mi,
    locate,
)

ONE_DEGREE_MI = EARTH_RADIUS_MI * math.pi / 180


def test_haversine_uses_the_mean_earth_radius_in_miles() -> None:
    assert EARTH_RADIUS_MI == 3958.7613
    assert haversine_mi((0.0, 0.0), (0.0, 1.0)) == pytest.approx(ONE_DEGREE_MI, rel=1e-12)
    assert haversine_mi((-111.891, 40.7608), (-104.9903, 39.7392)) == pytest.approx(371.0, abs=1.0)
    assert haversine_mi((10.0, 10.0), (10.0, 10.0)) == 0.0
    assert haversine_mi((0.0, 0.0), (180.0, 0.0)) == pytest.approx(math.pi * EARTH_RADIUS_MI)


def test_build_path_rescales_cumulative_miles_to_the_provider_length() -> None:
    path = build_path([(0.0, 0.0), (0.0, 1.0), (0.0, 3.0)], [0.0, 600.0, 1800.0], 250.0)

    assert path.coords == ((0.0, 0.0), (0.0, 1.0), (0.0, 3.0))
    assert path.cum_mi[0] == 0.0
    assert path.cum_mi[-1] == 250.0  # exactly the provider's length
    assert path.cum_mi[1] == pytest.approx(250.0 / 3)
    assert path.cum_s == (0.0, 600.0, 1800.0)
    assert (path.length_mi, path.duration_s) == (250.0, 1800.0)


def test_build_path_keeps_duplicate_points_monotonic() -> None:
    path = build_path([(0.0, 0.0), (0.0, 1.0), (0.0, 1.0)], [0.0, 60.0, 60.0], 70.0)

    assert path.cum_mi == (0.0, 70.0, 70.0)


@pytest.mark.parametrize(
    ("coords", "cum_s", "length", "message"),
    [
        ([(0.0, 0.0)], [0.0], 1.0, "at least 2 coordinates"),
        ([(0.0, 0.0), (0.0, 1.0)], [0.0], 1.0, "align"),
        ([(0.0, 0.0), (math.nan, 1.0)], [0.0, 1.0], 1.0, "finite"),
        ([(0.0, 0.0), (0.0, 91.0)], [0.0, 1.0], 1.0, "latitude"),
        ([(0.0, 0.0), (-180.5, 1.0)], [0.0, 1.0], 1.0, "longitude"),
        ([(0.0, 0.0), (0.0, 1.0)], [5.0, 10.0], 1.0, "start at 0"),
        ([(0.0, 0.0), (0.0, 1.0), (0.0, 2.0)], [0.0, 10.0, 9.0], 1.0, "non-decreasing"),
        ([(0.0, 0.0), (0.0, 1.0)], [0.0, math.inf], 1.0, "finite"),
        ([(0.0, 0.0), (0.0, 1.0)], [0.0, 1.0], 0.0, "provider length"),
        ([(0.0, 0.0), (0.0, 1.0)], [0.0, 1.0], math.nan, "provider length"),
        ([(5.0, 5.0), (5.0, 5.0)], [0.0, 1.0], 1.0, "coincide"),
    ],
    ids=[
        "one-point",
        "ragged",
        "nan-coordinate",
        "latitude-range",
        "longitude-range",
        "time-not-from-zero",
        "time-decreasing",
        "time-not-finite",
        "zero-length",
        "nan-length",
        "all-coincide",
    ],
)
def test_build_path_validates_its_inputs(
    coords: list[tuple[float, float]], cum_s: list[float], length: float, message: str
) -> None:
    with pytest.raises(InvalidPathError, match=message):
        build_path(coords, cum_s, length)


def test_route_paths_enforce_their_invariants_when_built_directly() -> None:
    with pytest.raises(InvalidPathError, match="non-decreasing"):
        RoutePath(coords=((0.0, 0.0), (0.0, 1.0)), cum_mi=(0.0, -1.0), cum_s=(0.0, 1.0))
    with pytest.raises(InvalidPathError, match="positive length"):
        RoutePath(coords=((0.0, 0.0), (0.0, 1.0)), cum_mi=(0.0, 0.0), cum_s=(0.0, 1.0))


PATH = build_path([(0.0, 0.0), (0.0, 1.0), (2.0, 1.0)], [0.0, 1000.0, 3000.0], 300.0)


def test_locate_interpolates_position_and_elapsed_time() -> None:
    first_leg = PATH.cum_mi[1]

    assert locate(PATH, 0.0) == ((0.0, 0.0), 0.0)
    assert locate(PATH, 300.0) == ((2.0, 1.0), 3000.0)
    assert locate(PATH, first_leg) == ((0.0, 1.0), 1000.0)
    (lon, lat), elapsed = locate(PATH, first_leg / 2)
    assert lon == 0.0
    assert lat == pytest.approx(0.5)
    assert elapsed == pytest.approx(500.0)
    (lon, lat), elapsed = locate(PATH, (first_leg + 300.0) / 2)
    assert lon == pytest.approx(1.0)
    assert lat == pytest.approx(1.0)
    assert elapsed == pytest.approx(2000.0)


@pytest.mark.parametrize("distance", [-0.001, 300.001, math.nan, math.inf])
def test_locate_rejects_distances_off_the_path(distance: float) -> None:
    with pytest.raises(InvalidPathError, match="outside the path"):
        locate(PATH, distance)


@pytest.mark.parametrize(
    ("start", "end", "expected_lon"),
    [((179.0, 0.0), (-179.0, 0.0), -179.5), ((-179.0, 0.0), (179.0, 0.0), 179.5)],
    ids=["eastward", "westward"],
)
def test_locate_takes_the_short_way_across_the_antimeridian(
    start: tuple[float, float], end: tuple[float, float], expected_lon: float
) -> None:
    path = build_path([start, end], [0.0, 100.0], 10.0)

    (lon, _), _ = locate(path, 7.5)

    assert lon == pytest.approx(expected_lon)
    assert haversine_mi(start, end) == pytest.approx(2 * ONE_DEGREE_MI)


def test_locate_can_land_exactly_on_the_antimeridian() -> None:
    path = build_path([(170.0, 0.0), (-170.0, 0.0)], [0.0, 100.0], 10.0)

    (lon, _), _ = locate(path, 5.0)

    assert lon == pytest.approx(180.0)
