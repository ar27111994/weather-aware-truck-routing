"""Single-flight on lease rows: coalesce identical work across instances, hold nothing meanwhile.

The properties this replaces advisory locks for (review R2-01, R2-10, R2-11 and the T5b residual):
no row lock, advisory lock, transaction or pooled connection is held while the work (an upstream
call) runs; work for *different* things never queues; identical work coalesces, also between
instances; a leader that fails or dies does not strand the others; the wait obeys the request's
deadline. A second :class:`SingleFlight` object stands in for another function instance: it shares
the table but not the in-process registry.
"""

import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from django.db import connection, connections
from django.utils import timezone

from haulcast.providers.deadline import deadline_scope
from haulcast.services.single_flight import FlightTimeoutError, Job, SingleFlight, lease_key
from haulcast.store.models import SingleFlightLease
from tests.dbtools import Connection
from tests.services.conftest import run_concurrently

pytestmark = pytest.mark.django_db(transaction=True)

LEASE_S = 30.0


def never() -> None:
    """A probe that never finds anything."""


def job[T](probe: Callable[[], T | None], work: Callable[[], T], *, wait_s: float = 5.0) -> Job[T]:
    return Job(probe=probe, work=work, lease_s=LEASE_S, wait_s=wait_s)


def hold_lease_elsewhere(kind: str, identity: str, *, seconds: float) -> None:
    """Pretend another instance leads ``kind``/``identity`` for ``seconds`` more seconds."""
    SingleFlightLease.objects.update_or_create(
        key=lease_key(kind, identity),
        defaults={
            "holder": "another-instance",
            "expires_at": timezone.now() + timedelta(seconds=seconds),
        },
    )


def end_lease_elsewhere(kind: str, identity: str, before: Callable[[], None] | None = None) -> None:
    """End the other instance's lease (runs in a timer thread, which owns its connection)."""
    try:
        if before is not None:
            before()
        SingleFlightLease.objects.filter(key=lease_key(kind, identity)).delete()
    finally:
        connections.close_all()


def lease_rows() -> int:
    return SingleFlightLease.objects.count()


# --------------------------------------------------------------------------- one caller


def test_a_lone_caller_works_once_and_leaves_no_lease_behind() -> None:
    calls: list[str] = []

    def work() -> str:
        calls.append("work")
        assert lease_rows() == 1  # the lease is held while it works
        return "value"

    result = SingleFlight().run("k", "id", job(never, work, wait_s=5))

    assert (result, calls) == ("value", ["work"])
    assert lease_rows() == 0


def test_the_probe_runs_after_the_claim_and_a_value_it_finds_ends_the_flight() -> None:
    def must_not_run() -> str:
        pytest.fail("the work must not run when the probe finds the value")

    result = SingleFlight().run("k", "id", job(lambda: "already there", must_not_run, wait_s=5))

    assert result == "already there"
    assert lease_rows() == 0


def test_the_lease_is_released_and_the_error_propagates_when_the_work_fails() -> None:
    def work() -> str:
        raise RuntimeError("upstream exploded")

    with pytest.raises(RuntimeError, match="upstream exploded"):
        SingleFlight().run("k", "id", job(never, work, wait_s=5))

    assert lease_rows() == 0


def test_the_stored_key_is_short_whatever_the_identity() -> None:
    identity = "ß" * 10_000

    SingleFlight().run("geocode", identity, job(never, lambda: 1, wait_s=5))

    assert len(lease_key("geocode", identity)) <= 64


# --------------------------------------------------------------------------- holding nothing


def test_no_transaction_and_no_lock_is_held_while_the_work_runs(
    admin_connection: Connection,
) -> None:
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_backend_pid()")
        row = cursor.fetchone()
    assert row is not None
    pid = row[0]
    observed: dict[str, object] = {}

    def work() -> str:
        observed["in_atomic_block"] = connection.in_atomic_block
        observed["state"] = admin_connection.execute(
            "SELECT state FROM pg_stat_activity WHERE pid = %s", [pid]
        ).fetchone()
        observed["locks"] = admin_connection.execute(
            "SELECT count(*) FROM pg_locks WHERE pid = %s "
            "AND locktype IN ('advisory', 'transactionid')",
            [pid],
        ).fetchone()
        return "value"

    SingleFlight().run("k", "id", job(never, work, wait_s=5))

    # "idle", not "idle in transaction": a transaction pooler would hand this server connection to
    # somebody else while the upstream call is in flight.
    assert observed == {"in_atomic_block": False, "state": ("idle",), "locks": (0,)}


# --------------------------------------------------------------------------- different work


def test_work_for_different_identities_never_queues() -> None:
    inside = threading.Barrier(2, timeout=30)
    flights = SingleFlight()

    def lead(index: int) -> int:
        def work() -> int:
            inside.wait()  # both are inside their own work at the same moment, or this raises
            return index

        return flights.run("k", f"id-{index}", job(never, work, wait_s=30))

    assert sorted(run_concurrently(2, lead)) == [0, 1]


# --------------------------------------------------------------------------- identical work


def test_identical_callers_in_one_process_share_one_computation_and_its_failure() -> None:
    callers = 5
    flights = SingleFlight()
    started = threading.Event()
    release = threading.Event()
    calls: list[int] = []

    def work() -> str:
        calls.append(1)
        started.set()
        assert release.wait(timeout=30)
        raise RuntimeError("upstream is down")

    def request(_index: int) -> str:
        try:
            return flights.run("k", "same", job(never, work, wait_s=30))
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=callers) as pool:
        leader = pool.submit(request, 0)
        assert started.wait(timeout=30)
        followers = [pool.submit(request, index) for index in range(1, callers)]
        time.sleep(0.3)  # let the followers reach the flight
        release.set()
        outcomes = [future.exception(timeout=60) for future in [leader, *followers]]

    # Probe P6 of the review: five callers used to make five loader calls, one after another.
    assert calls == [1]
    assert all(isinstance(error, RuntimeError) for error in outcomes)
    assert len({id(error) for error in outcomes}) == 1  # they all got the leader's failure


def test_a_value_the_leader_stored_is_found_by_the_followers_probe() -> None:
    callers = 4
    flights = SingleFlight()
    store: dict[str, str] = {}
    started = threading.Event()
    release = threading.Event()
    calls: list[int] = []

    def work() -> str:
        calls.append(1)
        started.set()
        assert release.wait(timeout=30)
        store["value"] = "computed"
        return "computed"

    def request(_index: int) -> str:
        try:
            return flights.run("k", "same", job(lambda: store.get("value"), work, wait_s=30))
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=callers) as pool:
        leader = pool.submit(request, 0)
        assert started.wait(timeout=30)
        rest = [pool.submit(request, index) for index in range(1, callers)]
        time.sleep(0.3)
        release.set()
        results = [future.result(timeout=60) for future in [leader, *rest]]

    assert results == ["computed"] * callers
    assert calls == [1]


def test_two_instances_coalesce_through_the_lease() -> None:
    first, second = SingleFlight(), SingleFlight()  # separate registries, one table
    store: dict[str, str] = {}
    started = threading.Event()
    release = threading.Event()
    calls: list[str] = []

    def slow_work() -> str:
        calls.append("first")
        started.set()
        assert release.wait(timeout=30)
        store["value"] = "computed"
        return "computed"

    def other_work() -> str:
        calls.append("second")
        return "recomputed"

    def probe() -> str | None:
        return store.get("value")

    def lead() -> str:
        try:
            return first.run("k", "same", job(probe, slow_work, wait_s=30))
        finally:
            connections.close_all()

    def follow() -> str:
        try:
            return second.run("k", "same", job(probe, other_work, wait_s=30))
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        leading = pool.submit(lead)
        assert started.wait(timeout=30)
        following = pool.submit(follow)
        time.sleep(0.4)  # the second instance is polling the lease now
        release.set()
        assert (leading.result(timeout=60), following.result(timeout=60)) == ("computed",) * 2

    assert calls == ["first"]


# --------------------------------------------------------------------------- crashes and waits


def test_a_lease_whose_holder_died_is_taken_over_once_it_expires() -> None:
    hold_lease_elsewhere("k", "id", seconds=-5)  # expired five seconds ago

    result = SingleFlight().run("k", "id", job(never, lambda: "mine", wait_s=5))

    assert result == "mine"
    assert lease_rows() == 0


def test_a_follower_takes_over_when_the_leader_ends_without_leaving_a_value() -> None:
    hold_lease_elsewhere("k", "id", seconds=60)
    threading.Timer(0.4, end_lease_elsewhere, args=("k", "id")).start()

    started = time.monotonic()
    result = SingleFlight().run("k", "id", job(never, lambda: "mine", wait_s=10))

    assert result == "mine"
    assert 0.3 <= time.monotonic() - started < 5


def test_a_value_that_appears_while_waiting_is_used_without_working() -> None:
    hold_lease_elsewhere("k", "id", seconds=60)
    store: dict[str, str] = {}

    def produced_elsewhere() -> None:
        store["value"] = "from the other instance"

    threading.Timer(0.4, end_lease_elsewhere, args=("k", "id", produced_elsewhere)).start()

    def must_not_run() -> str:
        pytest.fail("somebody else produced the value")

    result = SingleFlight().run("k", "id", job(lambda: store.get("value"), must_not_run, wait_s=10))

    assert result == "from the other instance"


def test_a_lease_that_never_ends_times_the_follower_out_without_working() -> None:
    hold_lease_elsewhere("k", "id", seconds=60)

    def must_not_run() -> str:
        pytest.fail("the lease is held by somebody else")

    started = time.monotonic()
    with pytest.raises(FlightTimeoutError):
        SingleFlight().run("k", "id", job(never, must_not_run, wait_s=0.4))

    assert 0.3 <= time.monotonic() - started < 5


def test_the_wait_never_outlasts_the_request_deadline() -> None:
    hold_lease_elsewhere("k", "id", seconds=60)

    started = time.monotonic()
    with deadline_scope(0.5), pytest.raises(FlightTimeoutError):
        SingleFlight().run("k", "id", job(never, lambda: "x", wait_s=30))

    assert time.monotonic() - started < 5
