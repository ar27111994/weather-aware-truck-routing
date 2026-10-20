"""Unit tests for the minimum-interval gate that spaces calls to the public demo servers."""

import math
import threading
import time
from itertools import pairwise

import pytest
from hypothesis import given
from hypothesis import strategies as st

from haulcast.providers.routing.throttle import MinIntervalGate
from tests.providers.routing.support import FakeClock


def make_gate(interval: float, clock: FakeClock) -> MinIntervalGate:
    return MinIntervalGate(interval, clock=clock, sleep=clock.sleep)


def test_the_first_call_never_waits() -> None:
    clock = FakeClock()

    make_gate(1.0, clock).wait()

    assert clock.sleeps == []


def test_a_call_right_after_another_waits_the_whole_interval() -> None:
    clock = FakeClock()
    gate = make_gate(1.0, clock)

    gate.wait()
    gate.wait()

    assert clock.sleeps == [1.0]


def test_a_call_waits_only_for_what_is_left_of_the_interval() -> None:
    clock = FakeClock()
    gate = make_gate(1.0, clock)

    gate.wait()
    clock.advance(0.25)
    gate.wait()

    assert clock.sleeps == pytest.approx([0.75])


def test_a_call_after_the_interval_has_passed_does_not_wait() -> None:
    clock = FakeClock()
    gate = make_gate(1.0, clock)

    gate.wait()
    clock.advance(1.5)
    gate.wait()

    assert clock.sleeps == []


def test_the_interval_is_measured_from_when_the_previous_call_was_released() -> None:
    clock = FakeClock()
    gate = make_gate(1.0, clock)

    gate.wait()
    gate.wait()  # sleeps 1.0 and is released at t0 + 1.0
    clock.advance(0.4)
    gate.wait()  # only 0.6 s remain of the interval that started at the second release

    assert clock.sleeps == pytest.approx([1.0, 0.6])


def test_a_zero_interval_never_waits() -> None:
    clock = FakeClock()
    gate = make_gate(0.0, clock)

    for _ in range(3):
        gate.wait()

    assert clock.sleeps == []


def test_the_default_clock_and_sleep_are_the_real_ones() -> None:
    gate = MinIntervalGate(0.0)

    gate.wait()
    gate.wait()


@pytest.mark.parametrize("interval", [-1.0, math.nan, math.inf])
def test_rejects_an_interval_that_is_not_a_finite_non_negative_number(interval: float) -> None:
    with pytest.raises(ValueError, match="min_interval_s must be a finite, non-negative number"):
        MinIntervalGate(interval)


def test_keeps_waiting_when_a_sleep_returns_early() -> None:
    clock = FakeClock()

    def impatient_sleep(seconds: float) -> None:
        clock.sleep(seconds * 0.9)

    gate = MinIntervalGate(1.0, clock=clock, sleep=impatient_sleep)
    gate.wait()
    released_first = clock.now
    gate.wait()

    assert clock.now - released_first >= 1.0


@given(
    gaps=st.lists(st.floats(min_value=0.0, max_value=3.0), min_size=1, max_size=25),
    interval=st.floats(min_value=0.0, max_value=2.0),
)
def test_consecutive_calls_are_never_released_closer_than_the_interval(
    gaps: list[float], interval: float
) -> None:
    clock = FakeClock()
    gate = make_gate(interval, clock)
    released: list[float] = []

    for gap in gaps:
        clock.advance(gap)
        gate.wait()
        released.append(clock.now)

    assert all(later - earlier >= interval - 1e-9 for earlier, later in pairwise(released))


class OverlappingSleepClock:
    """Fake time where concurrent sleeps overlap, as real ones do: sleeping never delays others.

    A gate that does not serialise its callers lets them sleep at the same time, so they are all
    released together; a correct gate releases them one interval apart. ``time.sleep(0)`` only
    yields the processor so that a second sleeper (if there is one) really overlaps the first.
    """

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        wake = self.now + seconds
        time.sleep(0)
        self.now = max(self.now, wake)


def test_concurrent_callers_are_released_one_interval_apart() -> None:
    clock = OverlappingSleepClock()
    gate = MinIntervalGate(1.0, clock=clock, sleep=clock.sleep)
    callers = 6
    start_together = threading.Barrier(callers)

    def call() -> None:
        start_together.wait()
        gate.wait()

    threads = [threading.Thread(target=call) for _ in range(callers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert not any(thread.is_alive() for thread in threads)
    assert clock.now == pytest.approx(callers - 1)
