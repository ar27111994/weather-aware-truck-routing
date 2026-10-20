"""Route statistics and ranking (DOMAIN-CONTRACT sections 7-8)."""

import math
from collections.abc import Sequence
from itertools import groupby, pairwise

import pytest
from hypothesis import given
from hypothesis import strategies as st

from haulcast.domain import (
    Assessment,
    Checkpoint,
    DecidedBy,
    InvalidAssessmentsError,
    InvalidCandidatesError,
    RiskLevel,
    RouteCandidate,
    RouteRiskStats,
    RouteStatus,
    rank_routes,
    ranking_key,
    summarize,
)
from tests.domain.support import DEFAULT_TIME, RULES

L, M, H, S, NT = (
    RiskLevel.LOW,
    RiskLevel.MODERATE,
    RiskLevel.HIGH,
    RiskLevel.SEVERE,
    RiskLevel.NO_TRAVEL,
)


def checkpoint(index: int, owned_mi: float) -> Checkpoint:
    return Checkpoint(
        index=index, distance_mi=float(index), lon=0.0, lat=0.0, eta=DEFAULT_TIME, owned_mi=owned_mi
    )


def assessment(level: RiskLevel | None) -> Assessment:
    return Assessment(level=level, factors={}, load_rule=None, incomplete=False, reasons=())


def make_stats(*, unknown: float = 0.0, **levels: float) -> RouteRiskStats:
    """Statistics as ``summarize`` reports them for miles per level id (``severe=12.5``)."""
    miles = dict.fromkeys(RiskLevel, 0.0) | {
        RiskLevel.from_id(level_id): mi for level_id, mi in levels.items()
    }
    known = math.fsum(miles.values())
    return RouteRiskStats(
        miles_by_level=miles,
        unknown_mi=unknown,
        avg_risk=math.fsum(level * mi for level, mi in miles.items()) / known if known else None,
        max_level=max((level for level, mi in miles.items() if mi > 0), default=None),
    )


def route(
    route_id: str, duration_s: float, *, label: str | None = None, **miles: float
) -> RouteCandidate:
    stats = make_stats(**miles)
    distance = math.fsum([*stats.miles_by_level.values(), stats.unknown_mi])
    return RouteCandidate(route_id, duration_s, distance, stats, label=label)


# --------------------------------------------------------------------------- summarize


def test_summarize_weights_each_level_by_owned_miles() -> None:
    owned = [12.5, 25.0, 17.5, 5.0]
    levels = [L, S, None, NT]

    stats = summarize(
        [checkpoint(i, mi) for i, mi in enumerate(owned)], [assessment(lv) for lv in levels]
    )

    assert dict(stats.miles_by_level) == {L: 12.5, M: 0.0, H: 0.0, S: 25.0, NT: 5.0}
    assert stats.unknown_mi == 17.5
    assert stats.avg_risk == pytest.approx((3 * 25.0 + 4 * 5.0) / 42.5)
    assert stats.max_level is NT


def test_summarize_reports_unknown_when_no_checkpoint_is_known() -> None:
    stats = summarize([checkpoint(0, 30.0), checkpoint(1, 30.0)], [assessment(None)] * 2)

    assert set(stats.miles_by_level.values()) == {0.0}
    assert (stats.unknown_mi, stats.avg_risk, stats.max_level) == (60.0, None, None)


def test_summarize_of_no_checkpoints_is_empty() -> None:
    stats = summarize([], [])

    assert dict(stats.miles_by_level) == dict.fromkeys(RiskLevel, 0.0)
    assert (stats.unknown_mi, stats.avg_risk, stats.max_level) == (0.0, None, None)


def test_summarize_rejects_unpaired_assessments() -> None:
    with pytest.raises(InvalidAssessmentsError, match="2 checkpoints cannot pair with 1"):
        summarize([checkpoint(0, 1.0), checkpoint(1, 1.0)], [assessment(L)])


@pytest.mark.parametrize(
    ("miles", "unknown", "avg"),
    [
        ({L: 1.0, M: 0.0, H: 0.0, S: 0.0}, 0.0, 0.0),
        ({L: -1.0, M: 0.0, H: 0.0, S: 0.0, NT: 0.0}, 0.0, 0.0),
        ({L: math.nan, M: 0.0, H: 0.0, S: 0.0, NT: 0.0}, 0.0, 0.0),
        ({L: 1.0, M: 0.0, H: 0.0, S: 0.0, NT: 0.0}, math.inf, 0.0),
        ({L: 1.0, M: 0.0, H: 0.0, S: 0.0, NT: 0.0}, 0.0, -0.001),
        ({L: 1.0, M: 0.0, H: 0.0, S: 0.0, NT: 0.0}, 0.0, 4.001),
        ({L: 1.0, M: 0.0, H: 0.0, S: 0.0, NT: 0.0}, 0.0, math.nan),
    ],
    ids=["missing-level", "negative", "nan-miles", "inf-unknown", "avg-low", "avg-high", "avg-nan"],
)
def test_route_stats_reject_values_that_cannot_be_ranked(
    miles: dict[RiskLevel, float], unknown: float, avg: float
) -> None:
    with pytest.raises(InvalidCandidatesError):
        RouteRiskStats(miles_by_level=miles, unknown_mi=unknown, avg_risk=avg, max_level=L)


@pytest.mark.parametrize(
    ("route_id", "duration", "distance", "message"),
    [
        ("", 10.0, 1.0, "non-empty route_id"),
        ("A", math.nan, 1.0, "duration_s"),
        ("A", -1.0, 1.0, "duration_s"),
        ("A", 10.0, math.inf, "distance_mi"),
        ("A", 10.0, -0.5, "distance_mi"),
    ],
)
def test_route_candidates_reject_invalid_provider_numbers(
    route_id: str, duration: float, distance: float, message: str
) -> None:
    with pytest.raises(InvalidCandidatesError, match=message):
        RouteCandidate(route_id, duration, distance, make_stats(low=1.0))


# --------------------------------------------------------------------------- rank_routes


def test_fewest_severe_miles_wins_even_when_slower() -> None:
    fast = route("B", 27840, low=500.0, severe=12.5)
    safe = route("A", 30120, low=509.3, high=3.1)

    ranking = rank_routes([fast, safe], RULES)

    assert ranking.order == ("A", "B")
    assert (ranking.recommended_id, ranking.decided_by, ranking.status) == (
        "A",
        DecidedBy.SEVERE_MI,
        RouteStatus.OK,
    )
    assert ranking.rationale == (
        (
            "Route A is recommended: it avoids Severe conditions that Route B crosses for 12.5 mi; "
            "+38 min vs the fastest option."
        ),
        "Route B ranks 2nd: 12.5 Severe miles vs 0.0 on Route A; the fastest option.",
    )
    assert ranking.warnings == ()


def test_any_no_travel_miles_lose_even_below_the_rounding_tolerance() -> None:
    sliver = route("A", 100, low=50.0, no_travel=0.04)
    severe = route("B", 160, low=20.0, severe=30.0)

    ranking = rank_routes([sliver, severe], RULES)

    assert ranking.order == ("B", "A")
    assert ranking.decided_by is DecidedBy.NO_TRAVEL_MI
    assert ranking.status is RouteStatus.OK
    assert ranking.rationale == (
        (
            "Route B is recommended: it avoids No Travel conditions that Route A crosses for less "
            "than 0.1 mi; +1 min vs the fastest option."
        ),
        "Route A ranks 2nd: less than 0.1 No Travel miles vs 0.0 on Route B; the fastest option.",
    )


def test_when_every_route_crosses_no_travel_the_least_exposed_is_recommended() -> None:
    worse = route("B", 3600, low=10.0, no_travel=7.5)
    better = route("A", 3660, low=10.0, no_travel=2.0)

    ranking = rank_routes([worse, better], RULES)

    assert ranking.order == ("A", "B")
    assert ranking.status is RouteStatus.NO_SAFE_ROUTE
    assert ranking.decided_by is DecidedBy.NO_TRAVEL_MI
    assert ranking.rationale == (
        (
            "Every route crosses No Travel conditions: none is safe to drive now, and Route A is "
            "the least exposed."
        ),
        (
            "Route A is recommended: it has the fewest No Travel miles (2.0 vs 7.5 on Route B); "
            "+1 min vs the fastest option."
        ),
        "Route B ranks 2nd: 7.5 No Travel miles vs 2.0 on Route A; the fastest option.",
    )


def test_fewest_high_miles_decide_when_severe_miles_tie_within_tolerance() -> None:
    first = route("A", 460, low=10.0, severe=12.04, high=1.0)
    second = route("B", 400, low=10.0, severe=12.0, high=4.25)

    ranking = rank_routes([second, first], RULES)

    assert ranking.order == ("A", "B")
    assert ranking.decided_by is DecidedBy.HIGH_MI
    assert ranking.rationale == (
        (
            "Route A is recommended: it has the fewest High miles (1.0 vs 4.2 on Route B); "
            "+1 min vs the fastest option."
        ),
        "Route B ranks 2nd: 4.2 High miles vs 1.0 on Route A; the fastest option.",
    )


def test_lowest_average_risk_decides_and_unknown_average_sorts_last() -> None:
    blind = route("A", 100, unknown=40.0)
    calm = route("B", 100, low=20.0, moderate=20.0)
    breezy = route("C", 100, low=10.0, moderate=30.0)

    ranking = rank_routes([blind, calm, breezy], RULES)

    assert ranking.order == ("B", "C", "A")
    assert ranking.decided_by is DecidedBy.AVG_RISK
    assert ranking.rationale == (
        (
            "Route B is recommended: it has the lowest average risk (0.500 vs 0.750 on Route C); "
            "the fastest option."
        ),
        "Route C ranks 2nd: average risk 0.750 vs 0.500 on Route B; the fastest option.",
        "Route A ranks 3rd: average risk unknown vs 0.500 on Route B; the fastest option.",
    )


def test_duration_decides_between_equally_safe_routes() -> None:
    slow = route("A", 27840, low=500.0)
    quick = route("B", 25560 + 45, low=500.0)

    ranking = rank_routes([slow, quick], RULES)

    assert ranking.order == ("B", "A")
    assert ranking.decided_by is DecidedBy.DURATION_S
    assert ranking.rationale == (
        (
            "Route B is recommended: it matches Route A on risk and is faster (7 h 07 min vs "
            "7 h 44 min); the fastest option."
        ),
        (
            "Route A ranks 2nd: same risk as Route B but slower (7 h 44 min vs 7 h 07 min); "
            "+37 min vs the fastest option."
        ),
    )


def test_exact_ties_keep_the_provider_order() -> None:
    first = route("B", 100.4, low=10.0)
    second = route("A", 100.0, low=10.0)

    ranking = rank_routes([first, second], RULES)

    assert ranking.order == ("B", "A")
    assert ranking.decided_by is DecidedBy.TIE
    assert ranking.rationale == (
        (
            "Route B is recommended: it ties Route A on every criterion and comes first in the "
            "routing provider's order; the fastest option."
        ),
        (
            "Route A ranks 2nd: it ties Route B on every criterion and comes later in the routing "
            "provider's order; the fastest option."
        ),
    )


def test_a_single_route_is_recommended_as_the_only_route() -> None:
    ranking = rank_routes([route("A", 27840, low=512.4)], RULES)

    assert ranking.order == ("A",)
    assert ranking.decided_by is DecidedBy.ONLY_ROUTE
    assert ranking.rationale == ("Route A is the only route found: 512.4 mi in 7 h 44 min.",)


def test_labels_name_the_routes_and_unknown_miles_raise_a_warning() -> None:
    north = route("A", 3600, label="Northern (I-80)", low=1000.0, unknown=12.5)
    south = route("B", 3600 + 59, label="Southern (I-70)", low=900.0, severe=3.0)

    ranking = rank_routes([north, south], RULES)

    assert ranking.rationale == (
        (
            "Northern (I-80) is recommended: it avoids Severe conditions that Southern (I-70) "
            "crosses for 3.0 mi; the fastest option."
        ),
        (
            "Southern (I-70) ranks 2nd: 3.0 Severe miles vs 0.0 on Northern (I-80); "
            "+59 s vs the fastest option."
        ),
    )
    assert ranking.warnings == (
        (
            "Northern (I-80) has no usable weather data for 12.5 of its 1,012.5 miles; its risk "
            "may be understated."
        ),
    )


def test_every_route_gets_an_ordinal_sentence() -> None:
    candidates = [route(f"R{n:02d}", 3600 + 60 * n, low=10.0) for n in range(1, 24)]

    ranking = rank_routes(candidates, RULES)

    ranks = [line.split(": ", 1)[0] for line in ranking.rationale[1:]]
    assert ranks[0] == "Route R02 ranks 2nd"
    assert ranks[1:3] == ["Route R03 ranks 3rd", "Route R04 ranks 4th"]
    assert ranks[9:12] == ["Route R11 ranks 11th", "Route R12 ranks 12th", "Route R13 ranks 13th"]
    assert ranks[19:22] == ["Route R21 ranks 21st", "Route R22 ranks 22nd", "Route R23 ranks 23rd"]
    assert ranking.rationale[-1].endswith("+22 min vs the fastest option.")
    assert len(ranking.rationale) == 23


def test_long_delays_are_formatted_in_hours_and_minutes() -> None:
    ranking = rank_routes([route("A", 0, low=1.0), route("B", 3570, low=1.0)], RULES)

    assert ranking.rationale[-1].endswith("+1 h 00 min vs the fastest option.")


@pytest.mark.parametrize(
    ("candidates", "message"),
    [
        ([], "at least one route"),
        ([route("A", 1, low=1.0), route("B", 1, low=1.0), route("A", 2, low=1.0)], "A"),
    ],
    ids=["empty", "duplicate-id"],
)
def test_rank_routes_rejects_unrankable_input(
    candidates: Sequence[RouteCandidate], message: str
) -> None:
    with pytest.raises(InvalidCandidatesError, match=message):
        rank_routes(candidates, RULES)


# --------------------------------------------------------------------------- properties

mile_amounts = st.one_of(
    st.sampled_from([0.0, 0.04, 0.05, 0.06, 10.0, 10.04, 10.06]),
    st.floats(min_value=0.0, max_value=500.0),
)


@st.composite
def candidate_lists(draw: st.DrawFn) -> list[RouteCandidate]:
    """1-6 routes with unique ids whose numbers often tie within or across tolerances."""
    count = draw(st.integers(min_value=1, max_value=6))
    candidates = []
    for index in range(count):
        levels = {
            name: draw(mile_amounts)
            for name in ("low", "moderate", "high", "severe", "no_travel", "unknown")
        }
        duration = draw(
            st.one_of(st.sampled_from([3600.0, 3600.4, 3601.0]), st.floats(0.0, 100_000.0))
        )
        stats = make_stats(**levels)
        distance = math.fsum([*stats.miles_by_level.values(), stats.unknown_mi])
        candidates.append(RouteCandidate(f"R{index}", duration, distance, stats))
    return candidates


@given(candidates=candidate_lists(), data=st.data())
def test_ranking_is_a_total_order_invariant_under_permutation(
    candidates: list[RouteCandidate], data: st.DataObject
) -> None:
    shuffled = data.draw(st.permutations(candidates))
    by_id = {c.route_id: c for c in candidates}

    for inputs in (candidates, shuffled):
        ranking = rank_routes(inputs, RULES)
        keys = [ranking_key(by_id[route_id], RULES) for route_id in ranking.order]
        assert sorted(ranking.order) == sorted(by_id)
        assert ranking.recommended_id == ranking.order[0]
        assert all(a <= b for a, b in pairwise(keys))  # total order on the key
        # Equal keys keep their input order (the only permutation-dependent part).
        position = {c.route_id: i for i, c in enumerate(inputs)}
        for _, group in groupby(ranking.order, key=lambda rid: ranking_key(by_id[rid], RULES)):
            members = list(group)
            assert members == sorted(members, key=position.__getitem__)

    def tie_groups(order: Sequence[str]) -> list[frozenset[str]]:
        return [
            frozenset(group)
            for _, group in groupby(order, key=lambda rid: ranking_key(by_id[rid], RULES))
        ]

    original, permuted = rank_routes(candidates, RULES), rank_routes(shuffled, RULES)
    assert tie_groups(original.order) == tie_groups(permuted.order)
    assert original.decided_by == permuted.decided_by
    assert original.status == permuted.status


@given(
    pieces=st.lists(
        st.tuples(
            st.floats(min_value=0.001, max_value=100.0),
            st.sampled_from([*RiskLevel, None]),
        ),
        max_size=40,
    )
)
def test_summarize_conserves_miles_and_bounds_the_average(
    pieces: list[tuple[float, RiskLevel | None]],
) -> None:
    stats = summarize(
        [checkpoint(i, mi) for i, (mi, _) in enumerate(pieces)],
        [assessment(level) for _, level in pieces],
    )

    total = math.fsum(mi for mi, _ in pieces)
    reported = math.fsum([*stats.miles_by_level.values(), stats.unknown_mi])
    assert reported == pytest.approx(total, rel=1e-9, abs=1e-12)
    known_levels = [level for _, level in pieces if level is not None]
    if known_levels:
        assert stats.avg_risk is not None
        assert 0.0 <= stats.avg_risk <= 4.0
        assert stats.max_level == max(known_levels)
        # A mile-weighted mean lies between the lowest and highest level (to float rounding).
        assert min(known_levels) - 1e-9 <= stats.avg_risk <= max(known_levels) + 1e-9
    else:
        assert (stats.avg_risk, stats.max_level) == (None, None)
    assert stats.unknown_mi >= 0.0
