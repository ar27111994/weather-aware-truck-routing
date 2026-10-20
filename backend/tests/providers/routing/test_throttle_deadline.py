"""The routing gate inside a request deadline: it never sleeps past the end of the request."""

import pytest

from haulcast.providers.deadline import deadline_scope
from haulcast.providers.errors import DeadlineExceededError, ProviderUnavailableError
from haulcast.providers.routing.throttle import MinIntervalGate
from tests.providers.routing.support import FakeClock


def make_gate(clock: FakeClock) -> MinIntervalGate:
    return MinIntervalGate(1.0, name="valhalla", clock=clock, sleep=clock.sleep)


def test_a_wait_that_fits_inside_the_deadline_is_taken() -> None:
    clock = FakeClock()
    gate = make_gate(clock)
    gate.wait()

    with deadline_scope(2.0, clock=clock):
        gate.wait()

    assert clock.sleeps == [1.0]


def test_a_wait_that_leaves_no_time_for_the_call_is_refused_before_sleeping() -> None:
    clock = FakeClock()
    gate = make_gate(clock)
    gate.wait()

    with deadline_scope(1.1, clock=clock), pytest.raises(DeadlineExceededError) as refused:
        gate.wait()  # one second of waiting plus the quarter second a call needs does not fit

    assert clock.sleeps == []
    assert refused.value.provider == "valhalla"
    assert isinstance(refused.value, ProviderUnavailableError)


def test_a_refused_wait_leaves_the_slot_for_whoever_comes_next() -> None:
    clock = FakeClock()
    gate = make_gate(clock)
    gate.wait()
    with deadline_scope(1.1, clock=clock), pytest.raises(DeadlineExceededError):
        gate.wait()

    clock.advance(0.5)
    gate.wait()

    assert clock.sleeps == [0.5]  # only what was left of the first call's interval


def test_a_gate_with_nothing_to_wait_for_never_consults_the_deadline() -> None:
    clock = FakeClock()
    gate = make_gate(clock)

    with deadline_scope(0.1, clock=clock):
        gate.wait()  # the first call needs no wait: even a nearly spent budget does not matter
        clock.advance(1.0)

    assert clock.sleeps == []
