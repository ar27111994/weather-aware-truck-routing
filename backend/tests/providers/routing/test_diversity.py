"""Tests of route distinctness and the diversity policy."""

import math
from collections.abc import Callable

import pytest

from haulcast.providers.routing.base import Coordinate, RouteOption
from haulcast.providers.routing.diversity import (
    DEFAULT_DIVERSITY,
    TARGET_ROUTES,
    DiversityPolicy,
    distinct_routes,
    is_distinct,
)


def meridian(lon: float, lat_from: float, lat_to: float, points: int = 200) -> list[Coordinate]:
    step = (lat_to - lat_from) / (points - 1)
    return [(lon, lat_from + step * index) for index in range(points)]


def option(coords: list[Coordinate], label: str = "via test") -> RouteOption:
    return RouteOption(
        coords=tuple(coords),
        cum_s=tuple(float(index) for index in range(len(coords))),
        distance_mi=10.0,
        duration_s=float(len(coords) - 1),
        summary=label,
    )


MAIN = option(meridian(-100.0, 40.0, 41.0))


def test_the_default_policy_carries_the_calibrated_numbers() -> None:
    assert DiversityPolicy() == DEFAULT_DIVERSITY
    assert TARGET_ROUTES == DEFAULT_DIVERSITY.target_routes == 3
    assert DEFAULT_DIVERSITY.overlap_threshold == 0.80
    assert (DEFAULT_DIVERSITY.tolerance_m, DEFAULT_DIVERSITY.step_m) == (250.0, 100.0)
    assert DEFAULT_DIVERSITY.anchor_fractions == (0.5, 0.25, 0.75, 0.4, 0.6)
    assert DEFAULT_DIVERSITY.polygon_half_size_deg == 0.01
    assert DEFAULT_DIVERSITY.max_extra_calls == 3  # D-17: at most three extra calls ...
    assert DEFAULT_DIVERSITY.stage_budget_s == 10.0  # ... inside a 10 s routing stage


NONSENSE = {
    "no-routes-wanted": (lambda: DiversityPolicy(target_routes=0), "target_routes"),
    "zero-threshold": (lambda: DiversityPolicy(overlap_threshold=0.0), "overlap_threshold"),
    "threshold-above-one": (lambda: DiversityPolicy(overlap_threshold=1.5), "overlap_threshold"),
    "zero-tolerance": (lambda: DiversityPolicy(tolerance_m=0.0), "tolerance_m and step_m"),
    "negative-step": (lambda: DiversityPolicy(step_m=-1.0), "tolerance_m and step_m"),
    "fraction-above-one": (
        lambda: DiversityPolicy(anchor_fractions=(0.5, 1.1)),
        "anchor fractions",
    ),
    "negative-fraction": (lambda: DiversityPolicy(anchor_fractions=(-0.1,)), "anchor fractions"),
    "zero-polygon": (lambda: DiversityPolicy(polygon_half_size_deg=0.0), "polygon_half_size_deg"),
    "nan-polygon": (
        lambda: DiversityPolicy(polygon_half_size_deg=math.nan),
        "polygon_half_size_deg",
    ),
    "negative-extra-calls": (lambda: DiversityPolicy(max_extra_calls=-1), "max_extra_calls"),
    "zero-budget": (lambda: DiversityPolicy(stage_budget_s=0.0), "stage_budget_s"),
    "infinite-budget": (lambda: DiversityPolicy(stage_budget_s=math.inf), "stage_budget_s"),
}


@pytest.mark.parametrize(("build", "message"), list(NONSENSE.values()), ids=list(NONSENSE))
def test_nonsensical_policies_are_refused(
    build: Callable[[], DiversityPolicy], message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        build()


def test_a_policy_may_forbid_extra_calls_and_use_no_anchors() -> None:
    policy = DiversityPolicy(max_extra_calls=0, anchor_fractions=())
    assert (policy.max_extra_calls, policy.anchor_fractions) == (0, ())


def test_an_identical_route_is_not_distinct() -> None:
    assert not is_distinct(option(meridian(-100.0, 40.0, 41.0)), [MAIN], DEFAULT_DIVERSITY)


def test_a_route_a_few_kilometres_away_is_distinct() -> None:
    assert is_distinct(option(meridian(-99.95, 40.0, 41.0)), [MAIN], DEFAULT_DIVERSITY)


def follow_then_leave(share: float) -> RouteOption:
    """Runs along MAIN for ``share`` of a degree of latitude, then heads diagonally to the east.

    The diagonal is longer than the stretch of MAIN it replaces, so the shared part is a little
    less than ``share`` of the route: about 84 % for 0.85 and about 70 % for 0.70.
    """
    return option([*meridian(-100.0, 40.0, 40.0 + share, 200), (-99.9, 41.0)])


def test_the_overlap_threshold_separates_duplicates_from_alternatives() -> None:
    assert not is_distinct(follow_then_leave(0.85), [MAIN], DEFAULT_DIVERSITY)
    assert is_distinct(follow_then_leave(0.70), [MAIN], DEFAULT_DIVERSITY)


def test_a_looser_threshold_accepts_what_a_stricter_one_refuses() -> None:
    candidate = follow_then_leave(0.85)
    assert is_distinct(candidate, [MAIN], DiversityPolicy(overlap_threshold=0.95))
    assert not is_distinct(candidate, [MAIN], DiversityPolicy(overlap_threshold=0.70))


def test_with_nothing_kept_every_route_is_distinct() -> None:
    assert is_distinct(MAIN, [], DEFAULT_DIVERSITY)


def test_a_candidate_must_differ_from_every_kept_route_not_just_the_first() -> None:
    east = option(meridian(-99.95, 40.0, 41.0), "east")
    east_again = option(meridian(-99.95, 40.0, 41.0), "east again")

    kept = distinct_routes([MAIN, east, east_again], DEFAULT_DIVERSITY)

    assert [route.summary for route in kept] == ["via test", "east"]


def test_distinct_routes_keep_the_order_the_provider_gave() -> None:
    west = option(meridian(-100.05, 40.0, 41.0), "west")
    east = option(meridian(-99.95, 40.0, 41.0), "east")

    assert [route.summary for route in distinct_routes([east, MAIN, west], DEFAULT_DIVERSITY)] == [
        "east",
        "via test",
        "west",
    ]


def test_no_candidates_keep_nothing() -> None:
    assert distinct_routes([], DEFAULT_DIVERSITY) == []


def test_no_more_than_the_target_number_of_routes_is_kept() -> None:
    # R2-21: the cap lives where distinctness is decided, so no adapter can exceed it.
    candidates = [option(meridian(-100.0 + 0.1 * index, 40.0, 41.0)) for index in range(5)]

    kept = distinct_routes(candidates, DEFAULT_DIVERSITY)

    assert kept == candidates[: DEFAULT_DIVERSITY.target_routes]
