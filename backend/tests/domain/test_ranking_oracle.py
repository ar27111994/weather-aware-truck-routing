"""The ranking against an independent oracle: D-31 on every list, and nothing else changed.

``oracle.py`` derives the order from the contract text with exact arithmetic and a pairwise
comparator. These properties compare ``rank_routes`` with it on lists full of ties, and prove the
two claims D-31 makes about the plans it does not concern: a plan without a low-coverage route
ranks exactly as it did before the key existed, and when every route is low-coverage the key ties
and the brief's keys decide.
"""

import math
from collections.abc import Callable

from hypothesis import event, given
from hypothesis import strategies as st

from haulcast.domain import RiskLevel, RouteCandidate, RouteRiskStats, rank_routes

from .oracle import low_coverage, oracle_decided_by, oracle_order, oracle_status
from .support import RULES

# Miles sit on a 0.1 mi grid plus two slivers, so every sum is a multiple of 0.02: no total can
# land on a half-step tie, where summing floats and summing decimals could round apart.
tenths = st.integers(min_value=1, max_value=600).map(lambda step: step / 10)
amounts = st.one_of(st.just(0.0), tenths, tenths, st.sampled_from([0.04, 0.06]))
small_unknown = st.one_of(st.just(0.0), st.just(0.0), st.integers(0, 50).map(lambda n: n / 10))
unknown_amounts = st.one_of(small_unknown, amounts)
averages = st.one_of(
    st.none(),
    st.sampled_from([0.0, 0.0005, 0.4996, 0.5, 0.5004, 0.5006, 1.25]),
    st.floats(min_value=0.0, max_value=4.0),
)
durations = st.one_of(
    st.sampled_from([3600.0, 3600.4, 3600.5, 3600.6, 3601.0, 3601.5, 7200.0]),
    st.floats(min_value=0.0, max_value=100_000.0),
)


def build(
    index: int,
    miles: dict[RiskLevel, float],
    unknown: float,
    avg: float | None,
    duration_s: float,
) -> RouteCandidate:
    stats = RouteRiskStats(miles_by_level=miles, unknown_mi=unknown, avg_risk=avg, max_level=None)
    distance = math.fsum([*miles.values(), unknown])
    return RouteCandidate(f"R{index}", duration_s, distance, stats)


@st.composite
def any_route(draw: st.DrawFn, index: int) -> RouteCandidate:
    miles = {level: draw(amounts) for level in RiskLevel}
    return build(index, miles, draw(unknown_amounts), draw(averages), draw(durations))


@st.composite
def blind_route(draw: st.DrawFn, index: int) -> RouteCandidate:
    """A route with little known and a lot unknown: low coverage whatever the numbers are."""
    miles = {level: draw(st.integers(0, 20).map(lambda n: n / 10)) for level in RiskLevel}
    unknown = draw(st.integers(min_value=300, max_value=3000).map(lambda n: n / 10))
    return build(index, miles, unknown, draw(averages), draw(durations))


def lists_of(
    route: Callable[[int], st.SearchStrategy[RouteCandidate]],
) -> st.SearchStrategy[list[RouteCandidate]]:
    """One to four routes drawn with ``route``, named R0, R1, ... in provider order."""
    return st.integers(min_value=1, max_value=4).flatmap(
        lambda count: st.tuples(*(route(index) for index in range(count))).map(list)
    )


routes_lists = lists_of(any_route)
blind_lists = lists_of(blind_route)
"""Routes that never separate on coverage."""


@given(candidates=routes_lists)
def test_the_ranking_equals_the_oracle_on_lists_full_of_ties(
    candidates: list[RouteCandidate],
) -> None:
    event(f"low-coverage routes: {sum(low_coverage(c) for c in candidates)} of {len(candidates)}")

    ranking = rank_routes(candidates, RULES)

    expected = oracle_order(candidates)
    assert list(ranking.order) == expected
    assert ranking.recommended_id == expected[0]
    assert ranking.decided_by.value == oracle_decided_by(candidates)
    assert ranking.status.value == oracle_status(candidates)


@given(candidates=routes_lists.filter(lambda cs: not any(low_coverage(c) for c in cs)))
def test_a_plan_without_a_low_coverage_route_ranks_as_it_did_before_the_key_existed(
    candidates: list[RouteCandidate],
) -> None:
    ranking = rank_routes(candidates, RULES)

    assert list(ranking.order) == oracle_order(candidates, coverage=False)
    assert ranking.decided_by.value == oracle_decided_by(candidates, coverage=False)


@given(candidates=blind_lists)
def test_when_every_route_is_low_coverage_the_briefs_keys_decide(
    candidates: list[RouteCandidate],
) -> None:
    ranking = rank_routes(candidates, RULES)

    assert all(low_coverage(c) for c in candidates)
    assert list(ranking.order) == oracle_order(candidates, coverage=False)
    assert ranking.decided_by.value == oracle_decided_by(candidates, coverage=False)
    assert ranking.decided_by.value != "coverage"
    assert (len(candidates) == 1) or any("every route" in line for line in ranking.warnings)
