"""Checkpoint planning (DOMAIN-CONTRACT section 6): distances, positions, ETAs, owned miles."""

import math
from datetime import UTC, datetime, timedelta, timezone
from itertools import pairwise
from typing import cast

import pytest
from hypothesis import given
from hypothesis import strategies as st

from haulcast.domain import (
    CHECKPOINT_EPSILON_MI,
    Checkpoint,
    InvalidIntervalError,
    InvalidPathError,
    NaiveDatetimeError,
    RoutePath,
    build_path,
    plan_checkpoints,
)
from tests.domain.support import DEFAULT_TIME, utc

MOUNTAIN = timezone(timedelta(hours=-6))


def straight_path(length_mi: float, duration_s: float = 3600.0) -> RoutePath:
    """A due-north path (0, 0) -> (0, 1) rescaled to ``length_mi`` and driven at constant speed."""
    return build_path([(0.0, 0.0), (0.0, 1.0)], [0.0, duration_s], length_mi)


def test_checkpoints_every_interval_then_the_destination() -> None:
    checkpoints = plan_checkpoints(straight_path(60.0), 25, DEFAULT_TIME)

    assert [c.index for c in checkpoints] == [0, 1, 2, 3]
    assert [c.distance_mi for c in checkpoints] == [0.0, 25.0, 50.0, 60.0]
    assert [c.owned_mi for c in checkpoints] == [12.5, 25.0, 17.5, 5.0]
    assert math.fsum(c.owned_mi for c in checkpoints) == 60.0


def test_positions_and_etas_are_interpolated_along_the_path() -> None:
    departure = datetime(2026, 10, 20, 8, 0, tzinfo=MOUNTAIN)
    checkpoints = plan_checkpoints(straight_path(60.0), 25, departure)

    origin, first, second, destination = checkpoints
    assert (origin.lon, origin.lat) == (0.0, 0.0)
    assert (destination.lon, destination.lat) == (0.0, 1.0)
    assert first.lat == pytest.approx(25 / 60)
    assert second.lat == pytest.approx(50 / 60)
    assert [c.eta for c in checkpoints] == [
        utc(2026, 10, 20, 14),
        utc(2026, 10, 20, 14, 25),
        utc(2026, 10, 20, 14, 50),
        utc(2026, 10, 20, 15),
    ]
    assert all(c.eta.tzinfo is UTC for c in checkpoints)


def test_a_route_shorter_than_the_interval_has_origin_and_destination_only() -> None:
    checkpoints = plan_checkpoints(straight_path(6.2), 25, DEFAULT_TIME)

    assert [(c.distance_mi, c.owned_mi) for c in checkpoints] == [(0.0, 3.1), (6.2, 3.1)]


@pytest.mark.parametrize(
    ("length", "interval", "distances"),
    [
        (50.005, 25, [0.0, 25.0, 50.005]),  # 50 is within epsilon of the end: no near-duplicate
        (50.02, 25, [0.0, 25.0, 50.0, 50.02]),  # 50 is more than epsilon short: kept
        (100.0, 50, [0.0, 50.0, 100.0]),  # an exact multiple ends on the destination once
        (0.011, 10, [0.0, 0.011]),  # the shortest route that can be sampled
        (31.0, 10, [0.0, 10.0, 20.0, 30.0, 31.0]),
    ],
)
def test_checkpoint_distances_follow_the_epsilon_rule(
    length: float, interval: int, distances: list[float]
) -> None:
    checkpoints = plan_checkpoints(straight_path(length), interval, DEFAULT_TIME)

    assert [c.distance_mi for c in checkpoints] == distances
    assert len(checkpoints) == math.ceil((length - CHECKPOINT_EPSILON_MI) / interval) + 1


@pytest.mark.parametrize("interval", [0, -25, True, 25.0, "25"])
def test_invalid_intervals_are_rejected(interval: object) -> None:
    with pytest.raises(InvalidIntervalError, match="positive whole number"):
        plan_checkpoints(straight_path(60.0), cast("int", interval), DEFAULT_TIME)


def test_a_naive_departure_is_rejected() -> None:
    with pytest.raises(NaiveDatetimeError, match="departure"):
        plan_checkpoints(straight_path(60.0), 25, DEFAULT_TIME.replace(tzinfo=None))


@pytest.mark.parametrize("length", [CHECKPOINT_EPSILON_MI, 0.005])
def test_a_route_within_epsilon_cannot_be_sampled(length: float) -> None:
    with pytest.raises(InvalidPathError, match=r"longer than 0\.01 mi"):
        plan_checkpoints(straight_path(length), 10, DEFAULT_TIME)


@pytest.mark.parametrize("owned", [0.0, -1.0, math.nan, math.inf])
def test_a_checkpoint_must_own_positive_finite_miles(owned: float) -> None:
    with pytest.raises(InvalidPathError, match="positive, finite number of miles"):
        Checkpoint(index=0, distance_mi=0.0, lon=0.0, lat=0.0, eta=DEFAULT_TIME, owned_mi=owned)


# --------------------------------------------------------------------------- properties


@st.composite
def route_paths(draw: st.DrawFn) -> RoutePath:
    """Northbound polylines of 2-30 points with non-decreasing times and a positive length."""
    count = draw(st.integers(min_value=2, max_value=30))
    lon = draw(st.floats(min_value=-170.0, max_value=170.0))
    lat = draw(st.floats(min_value=-60.0, max_value=0.0))
    coords = [(lon, lat)]
    times = [0.0]
    for _ in range(count - 1):
        lon += draw(st.floats(min_value=-0.5, max_value=0.5))
        lat += draw(st.floats(min_value=0.001, max_value=0.5))
        coords.append((lon, lat))
        times.append(times[-1] + draw(st.floats(min_value=0.0, max_value=3600.0)))
    length = draw(st.floats(min_value=0.02, max_value=3000.0))
    return build_path(coords, times, length)


# Hypothesis takes naive bounds and attaches the sampled time zone itself.
departures = st.datetimes(
    min_value=utc(2000, 1, 1).replace(tzinfo=None),
    max_value=utc(2100, 1, 1).replace(tzinfo=None),
    timezones=st.sampled_from([UTC, MOUNTAIN, timezone(timedelta(hours=5, minutes=30))]),
)
intervals = st.one_of(st.sampled_from([10, 25, 50]), st.integers(min_value=1, max_value=500))


@given(path=route_paths(), interval=intervals, departure=departures)
def test_checkpoint_invariants_hold_for_any_route(
    path: RoutePath, interval: int, departure: datetime
) -> None:
    checkpoints = plan_checkpoints(path, interval, departure)
    length = path.length_mi

    # Count formula, origin first, destination last.
    assert len(checkpoints) == math.ceil((length - CHECKPOINT_EPSILON_MI) / interval) + 1
    assert (checkpoints[0].lon, checkpoints[0].lat) == path.coords[0]
    assert (checkpoints[-1].lon, checkpoints[-1].lat) == path.coords[-1]
    assert checkpoints[0].distance_mi == 0.0
    assert checkpoints[-1].distance_mi == length
    assert checkpoints[0].eta == departure
    assert checkpoints[-1].eta == departure + timedelta(seconds=path.duration_s)
    # Distances strictly increase; ETAs never decrease along the route.
    assert all(a.distance_mi < b.distance_mi for a, b in pairwise(checkpoints))
    assert all(a.eta <= b.eta for a, b in pairwise(checkpoints))
    # Owned miles are positive and add up to the route length.
    assert all(c.owned_mi > 0 for c in checkpoints)
    assert math.fsum(c.owned_mi for c in checkpoints) == pytest.approx(length, rel=1e-9)
    assert [c.index for c in checkpoints] == list(range(len(checkpoints)))
