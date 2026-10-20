"""Upstream budgets and advisory locks: shared across instances through PostgreSQL."""

import threading
import time

import pytest
from django.db import connection

from haulcast.services.budget import (
    OPEN_METEO,
    ROUTING,
    Budget,
    BudgetExhaustedError,
    BudgetWindow,
    UpstreamBudgetGuard,
)
from haulcast.services.locks import LockUnavailableError, advisory_lock
from haulcast.store.models import UpstreamBudget
from tests.services.conftest import run_concurrently

HOURLY_20 = Budget("test-hourly", (BudgetWindow("hour", 20, 3_600),))
TWO_WINDOWS = Budget("test-two", (BudgetWindow("minute", 5, 60), BudgetWindow("day", 8, 86_400)))


# --------------------------------------------------------------------------- budgets


def test_the_contract_budgets_are_encoded() -> None:
    assert [(w.name, w.limit, w.window_s) for w in OPEN_METEO.windows] == [
        ("minute", 500, 60),
        ("hour", 4_500, 3_600),
        ("day", 9_000, 86_400),
    ]
    assert [(w.name, w.limit, w.window_s) for w in ROUTING.windows] == [("minute", 40, 60)]


@pytest.mark.django_db
def test_a_take_within_the_budget_succeeds_and_charges_every_window() -> None:
    UpstreamBudgetGuard().take(OPEN_METEO, 3)

    rows = {row.key: row for row in UpstreamBudget.objects.filter(key__startswith="openmeteo:")}
    assert set(rows) == {"openmeteo:minute", "openmeteo:hour", "openmeteo:day"}
    for window in OPEN_METEO.windows:
        charged = rows[f"openmeteo:{window.name}"]
        interval = window.window_s / window.limit
        assert (charged.tat - charged.updated_at).total_seconds() == pytest.approx(
            3 * interval, abs=1
        )


@pytest.mark.django_db
def test_exhausting_a_window_raises_with_a_retry_hint() -> None:
    guard = UpstreamBudgetGuard()
    guard.take(HOURLY_20, 20)

    with pytest.raises(BudgetExhaustedError) as refusal:
        guard.take(HOURLY_20, 1)

    assert refusal.value.budget == "test-hourly"
    assert 170 <= refusal.value.retry_after_s <= 180  # one token every 3600 / 20 = 180 s
    assert "test-hourly" in str(refusal.value)


@pytest.mark.django_db
def test_a_cost_that_does_not_fit_right_now_takes_nothing() -> None:
    guard = UpstreamBudgetGuard()
    guard.take(HOURLY_20, 15)

    with pytest.raises(BudgetExhaustedError):
        guard.take(HOURLY_20, 10)
    guard.take(HOURLY_20, 5)  # the refused 10 left the remaining 5 intact


@pytest.mark.django_db
def test_a_refusal_by_one_window_gives_back_the_tokens_of_the_others() -> None:
    guard = UpstreamBudgetGuard()
    guard.take(TWO_WINDOWS, 5)

    with pytest.raises(BudgetExhaustedError):
        guard.take(TWO_WINDOWS, 3)  # the minute window (5) is empty; the day window (8) is not

    day = UpstreamBudget.objects.get(key="test-two:day")
    interval = 86_400 / 8
    assert (day.tat - day.updated_at).total_seconds() == pytest.approx(5 * interval, abs=1)


@pytest.mark.django_db
@pytest.mark.parametrize("cost", [0, -1, 9, 10_000])
def test_costs_that_can_never_fit_are_programming_errors(cost: int) -> None:
    with pytest.raises(ValueError, match="cost must be between 1 and"):
        UpstreamBudgetGuard().take(TWO_WINDOWS, cost)


@pytest.mark.django_db(transaction=True)
def test_the_budget_is_exact_under_concurrency() -> None:
    """Thirty racing takes of one call each against 20 tokens: exactly 20 succeed."""
    guard = UpstreamBudgetGuard()

    def take(_: int) -> bool:
        try:
            guard.take(HOURLY_20, 1)
        except BudgetExhaustedError:
            return False
        return True

    outcomes = run_concurrently(30, take)

    assert outcomes.count(True) == 20
    assert outcomes.count(False) == 10


# --------------------------------------------------------------------------- advisory locks


@pytest.mark.django_db
def test_the_lock_can_be_taken_and_retaken_once_released() -> None:
    with advisory_lock("test-lock-reuse"):
        pass
    with advisory_lock("test-lock-reuse"):
        pass


@pytest.mark.django_db
def test_the_lock_body_runs_inside_a_transaction() -> None:
    with advisory_lock("test-lock-transaction"):
        assert connection.in_atomic_block


@pytest.mark.django_db(transaction=True)
def test_a_held_lock_makes_a_second_taker_give_up_after_its_timeout() -> None:
    holder_has_it = threading.Event()
    release = threading.Event()

    def hold() -> None:
        try:
            with advisory_lock("test-lock-contended"):
                holder_has_it.set()
                release.wait(timeout=30)
        finally:
            connection.close()

    holder = threading.Thread(target=hold)
    holder.start()
    try:
        assert holder_has_it.wait(timeout=30)
        started = time.perf_counter()
        with (
            pytest.raises(LockUnavailableError),
            advisory_lock("test-lock-contended", timeout_s=0.3),
        ):
            pytest.fail("the contended lock must not be granted")
        waited = time.perf_counter() - started
    finally:
        release.set()
        holder.join(timeout=30)

    assert 0.25 <= waited < 5
    with advisory_lock("test-lock-contended"):  # free again once the holder's transaction ended
        pass


@pytest.mark.django_db(transaction=True)
def test_different_names_never_block_each_other() -> None:
    inside = threading.Barrier(2, timeout=30)

    def take(index: int) -> None:
        with advisory_lock(f"test-lock-independent-{index}", timeout_s=5):
            inside.wait()  # both threads are inside their own lock at the same time

    run_concurrently(2, take)
