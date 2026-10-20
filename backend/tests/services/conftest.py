"""Helpers for the services tests: a controllable clock and real threads on real connections."""

import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

import pytest
from django.db import connections


class FakeClock:
    """A settable monotonic clock: ``clock()`` reads it, ``clock.advance(s)`` moves it."""

    def __init__(self, start: float = 1_000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        """Move time forward by ``seconds``."""
        self.now += seconds


def run_concurrently[T](count: int, work: Callable[[int], T]) -> list[T]:
    """Run ``work(index)`` in ``count`` threads released together by a barrier.

    Each thread owns its database connections (Django connections are thread-local) and closes
    them when done. An exception raised in any thread is re-raised here.
    """
    barrier = threading.Barrier(count)

    def task(index: int) -> T:
        try:
            barrier.wait(timeout=30)
            return work(index)
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=count) as pool:
        futures = [pool.submit(task, index) for index in range(count)]
        return [future.result(timeout=120) for future in futures]


def wait_until(condition: Callable[[], bool], *, timeout_s: float = 30.0) -> None:
    """Poll ``condition`` until it holds; fail the test when it does not within ``timeout_s``.

    For synchronising with another thread on something observable, instead of sleeping for a
    guessed time, which a loaded machine makes wrong.
    """
    give_up = time.monotonic() + timeout_s
    while not condition():
        assert time.monotonic() < give_up, "the awaited condition never came true"
        time.sleep(0.01)


@pytest.fixture
def clock() -> FakeClock:
    """A fresh fake clock."""
    return FakeClock()
