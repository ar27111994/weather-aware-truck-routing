"""Advisory locks: cross-instance mutual exclusion through PostgreSQL (retired by the leases)."""

import threading
import time

import pytest
from django.db import connection

from haulcast.services.locks import LockUnavailableError, advisory_lock
from tests.services.conftest import run_concurrently


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
