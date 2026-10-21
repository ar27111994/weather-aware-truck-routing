"""Unit tests for the pure geometry helpers behind route distinctness and forced diversity."""

import math
import time
from itertools import pairwise

import pytest
from hypothesis import assume, given
from hypothesis import strategies as st

from haulcast.providers.routing.base import Coordinate
from haulcast.providers.routing.geometry import (
    EARTH_RADIUS_MI,
    anchor_at_fraction,
    densify,
    great_circle_km,
    haversine_km,
    haversine_m,
    haversine_mi,
    is_distinct_route,
    overlap_fraction,
)
from tests.providers.routing.support import valhalla_route_coords

KM_PER_MILE = 1.609344
METRES_PER_DEGREE = EARTH_RADIUS_MI * KM_PER_MILE * 1000 * math.pi / 180

CHICAGO: Coordinate = (-87.6298, 41.8781)
DENVER: Coordinate = (-104.9903, 39.7392)
LOS_ANGELES: Coordinate = (-118.2437, 34.0522)
NEW_YORK: Coordinate = (-74.0060, 40.7128)

EQUATOR_ROUTE: tuple[Coordinate, ...] = ((0.0, 0.0), (0.1, 0.0))  # 11.1 km due east

_LON = st.floats(min_value=-180.0, max_value=180.0, allow_nan=False)
_LAT = st.floats(min_value=-90.0, max_value=90.0, allow_nan=False)
_POINT = st.tuples(_LON, _LAT)
_NEARBY = st.tuples(
    st.floats(min_value=10.0, max_value=10.05),
    st.floats(min_value=45.0, max_value=45.05),
)


# --------------------------------------------------------------------------- haversine


def test_the_earth_radius_is_the_domain_contract_value() -> None:
    assert EARTH_RADIUS_MI == 3958.7613


def test_one_degree_of_latitude_spans_one_degree_of_the_contract_radius() -> None:
    assert haversine_mi((0.0, 0.0), (0.0, 1.0)) == pytest.approx(EARTH_RADIUS_MI * math.pi / 180)


def test_distances_between_known_cities_match_the_research() -> None:
    # PROVIDERS.md Q1 fact 9: Chicago -> Denver is 1,478 km (918 mi); Los Angeles -> New York
    # is about 3,940 km.
    assert great_circle_km(CHICAGO, DENVER) == pytest.approx(1478, abs=1)
    assert haversine_mi(CHICAGO, DENVER) == pytest.approx(918, abs=1)
    assert great_circle_km(LOS_ANGELES, NEW_YORK) == pytest.approx(3940, abs=5)


@given(_POINT, _POINT)
def test_haversine_units_agree_and_the_distance_is_symmetric_and_bounded(
    a: Coordinate, b: Coordinate
) -> None:
    miles = haversine_mi(a, b)

    assert miles == pytest.approx(haversine_mi(b, a))
    assert 0.0 <= miles <= math.pi * EARTH_RADIUS_MI + 1e-6
    assert haversine_km(a, b) == pytest.approx(miles * KM_PER_MILE)
    assert haversine_m(a, b) == pytest.approx(miles * KM_PER_MILE * 1000)
    assert great_circle_km(a, b) == haversine_km(a, b)


@given(_POINT)
def test_the_distance_from_a_point_to_itself_is_zero(point: Coordinate) -> None:
    assert haversine_mi(point, point) == 0.0


@given(
    lon=st.floats(min_value=-179.9, max_value=-0.1),
    lat=st.floats(min_value=-90.0, max_value=90.0),
)
def test_antipodal_points_are_half_the_circumference_apart_without_domain_errors(
    lon: float, lat: float
) -> None:
    antipode = (lon + 180.0, -lat)

    assert haversine_mi((lon, lat), antipode) == pytest.approx(math.pi * EARTH_RADIUS_MI)


# --------------------------------------------------------------------------- densify


def test_densify_splits_a_segment_into_floor_of_length_over_step_equal_parts() -> None:
    # 0.01 degrees of latitude is 1,111.95 m: eleven parts of 101.09 m.
    result = densify([(0.0, 0.0), (0.0, 0.01)], 100.0)

    assert len(result) == 12
    assert [haversine_m(p, q) for p, q in pairwise(result)] == pytest.approx(
        [1111.95 / 11] * 11, rel=1e-3
    )


def test_densify_uses_the_requested_step() -> None:
    assert len(densify([(0.0, 0.0), (0.0, 0.01)], 50.0)) == 23


@pytest.mark.parametrize("degrees", [0.0004, 0.0009, 0.0017])
def test_densify_leaves_segments_shorter_than_twice_the_step_alone(degrees: float) -> None:
    # 44 m, 100 m and 189 m: the research reference only inserts points from 2 x step.
    segment = ((0.0, 0.0), (0.0, degrees))

    assert densify(segment, 100.0) == segment


def test_densify_interpolates_linearly_in_longitude_and_latitude() -> None:
    # 111 m east and 222 m north: 249 m long, so two equal parts.
    result = densify([(0.0, 0.0), (0.001, 0.002)], 100.0)

    assert len(result) == 3
    assert result[1] == pytest.approx((0.0005, 0.001))


def test_densify_of_nothing_or_one_point_is_unchanged() -> None:
    assert densify([], 100.0) == ()
    assert densify([(1.0, 2.0)], 100.0) == ((1.0, 2.0),)


@pytest.mark.parametrize("step_m", [0.0, -5.0, math.nan])
def test_densify_rejects_a_step_that_is_not_positive(step_m: float) -> None:
    with pytest.raises(ValueError, match="step_m must be positive"):
        densify([(0.0, 0.0), (0.0, 1.0)], step_m)


@given(
    points=st.lists(_NEARBY, min_size=1, max_size=15),
    step_m=st.floats(min_value=5.0, max_value=500.0),
)
def test_densify_keeps_every_input_vertex_in_order(points: list[Coordinate], step_m: float) -> None:
    result = iter(densify(points, step_m))

    assert all(vertex in result for vertex in points)


@given(a=_NEARBY, b=_NEARBY, step_m=st.floats(min_value=5.0, max_value=500.0))
def test_densify_spacing_stays_between_the_step_and_twice_the_step(
    a: Coordinate, b: Coordinate, step_m: float
) -> None:
    length = haversine_m(a, b)
    result = densify([a, b], step_m)
    gaps = [haversine_m(p, q) for p, q in pairwise(result)]

    assert result[0] == a
    assert result[-1] == b
    assert all(gap < 2 * step_m * (1 + 1e-9) for gap in gaps)
    if length >= step_m:
        # Linear interpolation in lon/lat is not a geodesic, so equal parts differ by ~1e-4.
        assert all(gap > step_m * (1 - 1e-3) for gap in gaps)


# --------------------------------------------------------------------------- anchor_at_fraction


def test_anchor_is_the_first_vertex_whose_following_segment_reaches_the_fraction() -> None:
    line = tuple((float(lon), 0.0) for lon in range(11))  # ten equal segments

    assert anchor_at_fraction(line, 0.55) == (5.0, 0.0)
    assert anchor_at_fraction(line, 0.25) == (2.0, 0.0)
    assert anchor_at_fraction(line, 0.01) == (0.0, 0.0)


def test_anchor_at_the_end_of_the_route_is_the_last_segment_start() -> None:
    line = tuple((float(lon), 0.0) for lon in range(11))

    assert anchor_at_fraction(line, 1.0) == (9.0, 0.0)


def test_anchor_reproduces_the_research_anchors_on_the_dallas_atlanta_route() -> None:
    route = valhalla_route_coords("valhalla-dal-atl-truck-alt2.json")

    # Recorded forced requests (samples/INDEX.json): exclude_locations lat/lon per fraction.
    assert anchor_at_fraction(route, 0.5) == (-90.302907, 32.313475)
    assert anchor_at_fraction(route, 0.25) == pytest.approx((-93.5663, 32.5417), abs=1e-4)
    assert anchor_at_fraction(route, 0.75) == pytest.approx((-87.3938, 33.1761), abs=1e-4)


@pytest.mark.parametrize("fraction", [-0.1, 1.1, math.nan])
def test_anchor_rejects_a_fraction_outside_zero_to_one(fraction: float) -> None:
    with pytest.raises(ValueError, match="fraction must be between 0 and 1"):
        anchor_at_fraction(((0.0, 0.0), (1.0, 0.0)), fraction)


@pytest.mark.parametrize("coords", [(), ((0.0, 0.0),)])
def test_anchor_needs_at_least_one_segment(coords: tuple[Coordinate, ...]) -> None:
    with pytest.raises(ValueError, match="at least two coordinates"):
        anchor_at_fraction(coords, 0.5)


@given(
    points=st.lists(_NEARBY, min_size=2, max_size=20),
    fraction=st.floats(min_value=0.0, max_value=1.0),
)
def test_anchor_is_always_one_of_the_route_vertices(
    points: list[Coordinate], fraction: float
) -> None:
    assert anchor_at_fraction(points, fraction) in points


# --------------------------------------------------------------------------- overlap_fraction


def test_a_route_overlaps_itself_completely() -> None:
    assert overlap_fraction(EQUATOR_ROUTE, EQUATOR_ROUTE) == 1.0


def test_routes_far_apart_do_not_overlap() -> None:
    assert overlap_fraction(EQUATOR_ROUTE, ((0.0, 1.0), (0.1, 1.0))) == 0.0


@pytest.mark.parametrize(
    ("offset_m", "expected"), [(100.0, 1.0), (240.0, 1.0), (260.0, 0.0), (400.0, 0.0)]
)
def test_a_parallel_route_overlaps_only_within_the_tolerance(
    offset_m: float, expected: float
) -> None:
    degrees = offset_m / METRES_PER_DEGREE

    assert overlap_fraction(EQUATOR_ROUTE, ((0.0, degrees), (0.1, degrees))) == expected


def test_the_tolerance_is_configurable() -> None:
    parallel = ((0.0, 300 / METRES_PER_DEGREE), (0.1, 300 / METRES_PER_DEGREE))

    assert overlap_fraction(EQUATOR_ROUTE, parallel) == 0.0
    assert overlap_fraction(EQUATOR_ROUTE, parallel, tolerance_m=350.0) == 1.0


def test_overlap_is_the_share_of_the_first_routes_length_near_the_second() -> None:
    half = ((0.0, 0.0), (0.05, 0.0))

    # Half the route plus the 250 m tolerance beyond its end: about 52 % of EQUATOR_ROUTE.
    assert overlap_fraction(EQUATOR_ROUTE, half) == pytest.approx(0.5225, abs=0.02)
    assert overlap_fraction(half, EQUATOR_ROUTE) == 1.0


def test_the_sampling_step_is_configurable() -> None:
    half = ((0.0, 0.0), (0.05, 0.0))

    # With a 5 km step the long route has three samples, 5.55 km apart, and two of them are near
    # the short route. An end sample stands for half a gap and the middle one for a whole gap, so
    # the two near ones are 1/4 + 1/2 of the route: a coarse answer, because the step is far above
    # the tolerance.
    assert overlap_fraction(EQUATOR_ROUTE, half, step_m=5000.0) == pytest.approx(0.75)
    # The default step resolves the 250 m tolerance: the stretch within it of the short route is
    # its 5.56 km plus 250 m, of the long route's 11.12 km.
    assert overlap_fraction(EQUATOR_ROUTE, half) == pytest.approx(0.52, abs=0.01)


def test_single_point_routes_overlap_when_within_the_tolerance() -> None:
    assert overlap_fraction([(5.0, 5.0)], [(5.0, 5.0)]) == 1.0
    assert overlap_fraction([(5.0, 5.0)], [(6.0, 5.0)]) == 0.0


@pytest.mark.parametrize(("a", "b"), [((), EQUATOR_ROUTE), (EQUATOR_ROUTE, ()), ((), ())])
def test_overlap_needs_both_routes_to_have_coordinates(
    a: tuple[Coordinate, ...], b: tuple[Coordinate, ...]
) -> None:
    with pytest.raises(ValueError, match="route has no coordinates"):
        overlap_fraction(a, b)


@pytest.mark.parametrize("tolerance_m", [0.0, -1.0, math.nan])
def test_overlap_rejects_a_tolerance_that_is_not_positive(tolerance_m: float) -> None:
    with pytest.raises(ValueError, match="tolerance_m must be positive"):
        overlap_fraction(EQUATOR_ROUTE, EQUATOR_ROUTE, tolerance_m=tolerance_m)


@given(st.lists(_NEARBY, min_size=1, max_size=20))
def test_every_route_overlaps_itself_completely(points: list[Coordinate]) -> None:
    assert overlap_fraction(points, points) == 1.0


@given(
    a=st.lists(_NEARBY, min_size=1, max_size=15),
    b=st.lists(_NEARBY, min_size=1, max_size=15),
)
def test_the_overlap_is_always_a_fraction(a: list[Coordinate], b: list[Coordinate]) -> None:
    assert 0.0 <= overlap_fraction(a, b) <= 1.0


@given(st.lists(_NEARBY, min_size=1, max_size=15))
def test_a_route_ten_degrees_away_never_overlaps(points: list[Coordinate]) -> None:
    far = [(lon, lat + 10.0) for lon, lat in points]

    assert overlap_fraction(points, far) == 0.0


@given(
    lon=st.floats(min_value=-170.0, max_value=170.0),
    lat=st.floats(min_value=-80.0, max_value=80.0),
    east_m=st.floats(min_value=-400.0, max_value=400.0),
    north_m=st.floats(min_value=-400.0, max_value=400.0),
)
def test_a_neighbour_is_found_exactly_when_it_is_within_the_tolerance_at_any_latitude(
    lon: float, lat: float, east_m: float, north_m: float
) -> None:
    # A fixed-degree grid loses east-west neighbours towards the poles; this one must not.
    here: Coordinate = (lon, lat)
    there: Coordinate = (
        lon + east_m / (METRES_PER_DEGREE * math.cos(math.radians(lat))),
        lat + north_m / METRES_PER_DEGREE,
    )
    distance = haversine_m(here, there)
    assume(abs(distance - 250.0) > 0.5)

    assert overlap_fraction([here], [there]) == (1.0 if distance <= 250.0 else 0.0)


@pytest.mark.parametrize(
    ("candidate", "reference", "by_length"),
    [
        # PROVIDERS.md Q2 "Forced-diversity call spec" records the overlaps of these real Valhalla
        # responses. Its reference implementation divides the *samples* near the other route by all
        # samples; the rule it states (and the API contract: "overlap < 80% by length") is the
        # share of the route's *length*. The two agree only where the vertices are evenly spread,
        # and a polyline describes a winding stretch with many more vertices than a straight one,
        # so they differ by up to 0.15 on these pairs (R2-20). The numbers below are by length;
        # the research's sample counts are beside them. Only one decision at 0.80 changes: the
        # last Chicago to Denver pair.
        (("force-dal-atl-50-loc", 0), ("dal-atl-truck-alt2", 0), 0.9920),  # research 0.9860
        (("force-dal-atl-50-poly", 0), ("dal-atl-truck-alt2", 0), 0.2660),  # research 0.2946
        (("force-dal-atl-25-loc", 0), ("force-dal-atl-50-poly", 0), 1.0),  # research 1.0
        (("force-dal-atl-75-loc", 0), ("dal-atl-truck-alt2", 0), 0.9771),  # research 0.9541
        (("force-dal-atl-75-poly", 0), ("force-dal-atl-50-poly", 0), 0.0220),  # research 0.0475
        (("force-la-phx-50-loc", 0), ("la-phx-truck-alt2", 0), 0.6470),  # research 0.6562
        (("force-la-phx-25-loc", 0), ("la-phx-truck-alt2", 0), 0.7823),  # research 0.6345
        (("force-la-phx-25-loc", 0), ("force-la-phx-50-loc", 0), 0.5612),  # research 0.4648
        (("force-chi-den-50-loc", 0), ("chi-den-truck-alt2", 0), 0.8277),  # research 0.8169
        (("force-chi-den-50-loc", 0), ("chi-den-truck-alt2", 1), 0.5223),  # research 0.5058
        (("force-chi-den-25-loc", 0), ("chi-den-truck-alt2", 0), 0.7942),  # research 0.7962
        (("force-chi-den-25-loc", 0), ("chi-den-truck-alt2", 1), 0.8019),  # research 0.7984
        (("slc-den-truck-alt2", 1), ("slc-den-truck-alt2", 0), 0.0621),  # research 0.0766
        (("slc-den-truck-alt2", 2), ("slc-den-truck-alt2", 0), 0.0118),  # research 0.0223
        (("slc-den-truck-alt2", 2), ("slc-den-truck-alt2", 1), 0.1365),  # research 0.1826
    ],
)
def test_the_overlap_of_the_recorded_routes_is_the_share_of_their_length(
    candidate: tuple[str, int], reference: tuple[str, int], by_length: float
) -> None:
    a = valhalla_route_coords(f"valhalla-{candidate[0]}.json", candidate[1])
    b = valhalla_route_coords(f"valhalla-{reference[0]}.json", reference[1])

    assert overlap_fraction(a, b) == pytest.approx(by_length, abs=0.0005)


def test_overlap_is_measured_by_length_whatever_the_density_of_the_vertices() -> None:
    # The same straight road along the equator, 22 km long, described twice: a vertex every 111 m
    # throughout, and with the first half described by a vertex every 11 m (as a winding road is).
    # The other route follows the first half only. By length that is the first 11.1 km plus the
    # 250 m tolerance, of 22.2 km: 0.511. Counting samples gives the winding description 0.91.
    plain = [(index * 0.001, 0.0) for index in range(201)]
    winding = [(index * 0.0001, 0.0) for index in range(1000)] + plain[100:]
    other = [(0.0, 0.0), (0.1, 0.0)]

    by_plain = overlap_fraction(plain, other)
    by_winding = overlap_fraction(winding, other)

    assert by_plain == pytest.approx(0.511, abs=0.01)
    assert by_winding == pytest.approx(by_plain, abs=0.005)


def test_overlap_by_length_gives_every_stretch_the_weight_of_its_own_length() -> None:
    # A route of 11 m steps for 1.1 km then 111 m steps for 11.1 km: only the 1.1 km is shared.
    # By length that is (1.1 km + the 250 m tolerance) / 12.1 km, about 0.11; by samples 0.52.
    fine = [(index * 0.0001, 0.0) for index in range(100)]
    coarse = [(0.01 + index * 0.001, 0.0) for index in range(100)]
    other = [(0.0, 0.0), (0.01, 0.0)]

    assert overlap_fraction([*fine, *coarse], other) == pytest.approx(0.1125, abs=0.01)


@pytest.mark.parametrize("distance_m", [0.0, 100.0, 900.0], ids=["same", "near", "far"])
def test_a_route_that_never_moves_overlaps_by_its_position(distance_m: float) -> None:
    here = (10.0, 45.0)
    stay = [here, here, here]  # no length at all: there is nothing to weigh, only where it is
    there = [(10.0 + distance_m / (METRES_PER_DEGREE * math.cos(math.radians(45.0))), 45.0)]

    assert overlap_fraction(stay, there) == (1.0 if distance_m <= 250.0 else 0.0)


def test_the_borderline_chicago_denver_route_duplicates_the_second_kept_route_by_length() -> None:
    # The recorded 0.25 loc route shares 79.4% of its length with the first kept route and 80.2%
    # with the second. The research's sample count said 79.6% and 79.8% and so let it through; the
    # rule is "less than 80% by length", so by the rule it is a duplicate (R2-20). It sits within
    # the sampling error of the threshold, so this pins the definition, not a property of the road.
    candidate = valhalla_route_coords("valhalla-force-chi-den-25-loc.json")
    first = valhalla_route_coords("valhalla-chi-den-truck-alt2.json", 0)
    second = valhalla_route_coords("valhalla-chi-den-truck-alt2.json", 1)
    rule = {"threshold": 0.80, "tolerance_m": 250.0, "step_m": 100.0}

    assert is_distinct_route(candidate, [first], **rule)
    assert not is_distinct_route(candidate, [second], **rule)
    assert not is_distinct_route(candidate, [first, second], **rule)


@pytest.mark.perf  # a wall-clock budget: run without coverage tracing, with the others (R2-35)
def test_overlap_of_a_500_mile_route_stays_fast() -> None:
    route = valhalla_route_coords("valhalla-slc-den-truck-alt2.json")  # 5,056 points, 537 mi

    def seconds() -> float:
        started = time.perf_counter()
        overlap_fraction(route, route)
        return time.perf_counter() - started

    # About 0.12 s without coverage tracing on a quiet machine (the research reference needs about
    # 0.5 s). The bound leaves room for coverage tracing and a busy CI runner, yet an O(n * m)
    # scan over the ~9,000 samples of each route would take minutes and still fail it.
    assert min(seconds() for _ in range(3)) < 2.0


# --------------------------------------------------------------------------- is_distinct_route


def test_a_route_is_distinct_when_nothing_has_been_kept_yet() -> None:
    assert is_distinct_route(EQUATOR_ROUTE, [], threshold=0.8, tolerance_m=250.0, step_m=100.0)


def test_a_route_must_be_below_the_threshold_against_every_kept_route() -> None:
    far = ((0.0, 1.0), (0.1, 1.0))
    settings = {"threshold": 0.8, "tolerance_m": 250.0, "step_m": 100.0}

    assert is_distinct_route(EQUATOR_ROUTE, [far], **settings)
    assert not is_distinct_route(EQUATOR_ROUTE, [far, EQUATOR_ROUTE], **settings)
    assert not is_distinct_route(EQUATOR_ROUTE, [EQUATOR_ROUTE, far], **settings)


def test_the_threshold_is_exclusive() -> None:
    settings = {"tolerance_m": 250.0, "step_m": 100.0}

    assert not is_distinct_route(EQUATOR_ROUTE, [EQUATOR_ROUTE], threshold=1.0, **settings)
    assert is_distinct_route(EQUATOR_ROUTE, [EQUATOR_ROUTE], threshold=1.01, **settings)
