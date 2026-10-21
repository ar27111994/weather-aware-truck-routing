"""The shared upstream budgets (decision D-19): exact windows, atomic takes, per-attempt hooks.

A budget says "at most ``limit`` calls in ANY window of ``window_s`` seconds". It is enforced by a
token bucket (GCRA) with a burst and a refill rate, and a bucket admits ``burst + rate`` calls in a
window starting from rest: the review probe P14 caught a bucket whose burst equalled its rate
letting 19 of a "10 per 2 s" budget through in 1.97 s. Every window therefore splits its limit
into a burst half and a refill half, so the limit is reached exactly and never exceeded.
"""

import math
import time

import pytest

from haulcast.providers.errors import UpstreamBudgetExhaustedError
from haulcast.services.budget import (
    OPEN_METEO,
    ROUTING,
    Budget,
    BudgetExhaustedError,
    BudgetWindow,
    UpstreamBudgetGuard,
)
from haulcast.store.models import UpstreamBudget
from tests.services.conftest import run_concurrently

HOURLY_20 = Budget("test-hourly", (BudgetWindow("hour", 20, 3_600),))
TWO_WINDOWS = Budget("test-two", (BudgetWindow("minute", 6, 60), BudgetWindow("day", 10, 86_400)))
DAY_THEN_MINUTE = Budget(
    "test-two-rev", (BudgetWindow("day", 10, 86_400), BudgetWindow("minute", 6, 60))
)


# --------------------------------------------------------------------------- the contract numbers


def test_the_contract_budgets_are_encoded() -> None:
    assert [(w.name, w.limit, w.window_s) for w in OPEN_METEO.windows] == [
        ("minute", 500, 60),
        ("hour", 4_500, 3_600),
        ("day", 9_000, 86_400),
    ]
    assert [(w.name, w.limit, w.window_s) for w in ROUTING.windows] == [("minute", 40, 60)]


def test_every_window_splits_its_limit_into_a_burst_and_a_refill_that_add_up_exactly() -> None:
    splits = {
        f"{budget.name}:{window.name}": (window.burst, window.rate)
        for budget in (OPEN_METEO, ROUTING)
        for window in budget.windows
    }

    assert splits == {
        "openmeteo:minute": (250, 250),
        "openmeteo:hour": (2_250, 2_250),
        "openmeteo:day": (4_500, 4_500),
        "routing:minute": (20, 20),
    }
    for budget in (OPEN_METEO, ROUTING):
        for window in budget.windows:
            assert window.burst + window.rate == window.limit


def test_a_window_whose_limit_cannot_be_split_is_refused() -> None:
    with pytest.raises(ValueError, match="at least 2"):
        BudgetWindow("minute", 1, 60)


def test_the_largest_single_call_fits_every_burst() -> None:
    # One Open-Meteo request carries at most 250 locations (its chunk size): a burst smaller than
    # that could never admit a full chunk.
    assert all(window.burst >= 250 for window in OPEN_METEO.windows)


# --------------------------------------------------------------------------- taking


@pytest.mark.django_db
def test_a_take_within_the_budget_succeeds_and_charges_every_window() -> None:
    UpstreamBudgetGuard().take(OPEN_METEO, 3)

    rows = {row.key: row for row in UpstreamBudget.objects.filter(key__startswith="openmeteo:")}
    assert set(rows) == {"openmeteo:minute", "openmeteo:hour", "openmeteo:day"}
    for window in OPEN_METEO.windows:
        charged = rows[f"openmeteo:{window.name}"]
        interval = window.window_s / window.rate
        assert (charged.tat - charged.updated_at).total_seconds() == pytest.approx(
            3 * interval, abs=1
        )


@pytest.mark.django_db
def test_exhausting_a_window_raises_with_a_retry_hint() -> None:
    guard = UpstreamBudgetGuard()
    guard.take(HOURLY_20, 10)

    with pytest.raises(BudgetExhaustedError) as refusal:
        guard.take(HOURLY_20, 1)

    assert refusal.value.budget == "test-hourly"
    assert 350 <= refusal.value.retry_after_s <= 360  # one token every 3600 / 10 = 360 s
    assert "test-hourly" in str(refusal.value)


@pytest.mark.django_db
def test_a_cost_that_does_not_fit_right_now_takes_nothing() -> None:
    guard = UpstreamBudgetGuard()
    guard.take(HOURLY_20, 6)

    with pytest.raises(BudgetExhaustedError):
        guard.take(HOURLY_20, 6)
    guard.take(HOURLY_20, 4)  # the refused 6 left the remaining 4 intact


@pytest.mark.django_db
@pytest.mark.parametrize(
    "budget",
    [TWO_WINDOWS, DAY_THEN_MINUTE],
    ids=["the-first-window-refuses", "the-last-window-refuses"],
)
def test_a_refusal_by_one_window_gives_back_the_tokens_of_the_others(budget: Budget) -> None:
    guard = UpstreamBudgetGuard()
    guard.take(budget, 3)  # the minute burst is 3: empty now; the day burst (5) has 2 left

    # Day first: the day window accepts these 2 and only then the minute window refuses, so the
    # take must give the day's 2 back. Minute first: it refuses before the day is touched.
    with pytest.raises(BudgetExhaustedError):
        guard.take(budget, 2)

    day = UpstreamBudget.objects.get(key=f"{budget.name}:day")
    interval = 86_400 / 5
    assert (day.tat - day.updated_at).total_seconds() == pytest.approx(3 * interval, abs=1)


@pytest.mark.django_db
@pytest.mark.parametrize("cost", [0, -1, 6, 10_000])
def test_costs_that_can_never_fit_are_programming_errors(cost: int) -> None:
    with pytest.raises(ValueError, match="cost must be between 1 and"):
        UpstreamBudgetGuard().take(TWO_WINDOWS, cost)


@pytest.mark.django_db(transaction=True)
def test_the_budget_is_exact_under_concurrency() -> None:
    """Thirty racing takes of one call each against a burst of 10: exactly 10 succeed."""
    guard = UpstreamBudgetGuard()

    def take(_: int) -> bool:
        try:
            guard.take(HOURLY_20, 1)
        except BudgetExhaustedError:
            return False
        return True

    outcomes = run_concurrently(30, take)

    assert outcomes.count(True) == 10
    assert outcomes.count(False) == 20


# --------------------------------------------------------------------------- the budget-math probe


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    ("limit", "window_s"),
    [(10, 1), (30, 1), (50, 2)],
    ids=["10-per-second", "30-per-second", "50-per-2-seconds"],
)
def test_no_window_ever_admits_more_than_its_limit_even_after_rest(
    limit: int, window_s: int
) -> None:
    # Probe P14 of the review, as a regression test: a rested bucket admits its burst at once and
    # then refills for the rest of the window. Taking as fast as possible for one window length,
    # the total must be the limit, never twice it.
    guard = UpstreamBudgetGuard()
    probe = Budget(f"probe-{limit}-{window_s}", (BudgetWindow("window", limit, window_s),))
    admitted = 0
    slowest_poll = 0.0

    started = time.monotonic()
    while time.monotonic() - started < window_s:
        polled = time.monotonic()
        try:
            guard.take(probe, 1)
        except BudgetExhaustedError:
            time.sleep(0.005)
        else:
            admitted += 1
        slowest_poll = max(slowest_poll, time.monotonic() - polled)

    # Never more than the limit. And not much less: a token that falls due while the loop is busy
    # with one poll is only seen after it, so the tokens that fall due during the last (slowest)
    # poll may be missed, plus the one that falls due exactly at the end. The slack follows the
    # poll the run actually saw, so a loaded machine cannot make a correct guard look stingy.
    interval = window_s / (limit - limit // 2)
    slack = math.ceil(slowest_poll / interval) + 1
    assert limit - slack <= admitted <= limit


# --------------------------------------------------------------------------- the attempt hook


@pytest.mark.django_db
def test_the_attempt_hook_charges_the_cost_of_each_attempt() -> None:
    hook = UpstreamBudgetGuard().attempt_hook(TWO_WINDOWS, "somebody")

    hook(1)
    hook(2)

    day = UpstreamBudget.objects.get(key="test-two:day")
    interval = 86_400 / 5
    assert (day.tat - day.updated_at).total_seconds() == pytest.approx(3 * interval, abs=1)


@pytest.mark.django_db
def test_the_attempt_hook_paces_before_it_charges() -> None:
    events: list[str] = []
    hook = UpstreamBudgetGuard().attempt_hook(
        HOURLY_20, "somebody", pace=lambda: events.append("pace")
    )

    hook(1)

    assert events == ["pace"]
    assert UpstreamBudget.objects.filter(key="test-hourly:hour").exists()


@pytest.mark.django_db
def test_a_refusal_reaches_the_caller_as_the_providers_own_capacity_error() -> None:
    guard = UpstreamBudgetGuard()
    hook = guard.attempt_hook(HOURLY_20, "open-meteo")
    guard.take(HOURLY_20, 10)

    with pytest.raises(UpstreamBudgetExhaustedError) as refusal:
        hook(1)

    assert refusal.value.provider == "open-meteo"
    assert refusal.value.retry_after_s is not None
    assert 350 <= refusal.value.retry_after_s <= 360
    assert isinstance(refusal.value.__cause__, BudgetExhaustedError)
