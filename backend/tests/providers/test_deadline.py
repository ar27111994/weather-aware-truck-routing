"""The request-scoped deadline: a wall-clock budget every outbound call consults."""

import pytest

from haulcast.providers.deadline import Deadline, current_deadline, deadline_scope


class Clock:
    """A controllable monotonic clock."""

    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def test_a_deadline_counts_down_and_never_goes_negative() -> None:
    clock = Clock()
    deadline = Deadline(5.0, clock=clock)

    assert (deadline.remaining(), deadline.expired()) == (5.0, False)
    clock.advance(3.5)
    assert (deadline.remaining(), deadline.expired()) == (1.5, False)
    clock.advance(10.0)
    assert (deadline.remaining(), deadline.expired()) == (0.0, True)


@pytest.mark.parametrize("seconds", [0.0, -1.0, float("inf"), float("nan")])
def test_a_deadline_needs_a_positive_finite_budget(seconds: float) -> None:
    with pytest.raises(ValueError, match="positive, finite"):
        Deadline(seconds)


def test_there_is_no_deadline_outside_a_scope() -> None:
    assert current_deadline() is None


def test_a_scope_installs_its_deadline_and_removes_it_even_when_the_work_fails() -> None:
    clock = Clock()

    def fail_inside_a_scope() -> None:
        with deadline_scope(5.0, clock=clock) as deadline:
            assert current_deadline() is deadline
            raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        fail_inside_a_scope()

    assert current_deadline() is None


def test_a_nested_scope_can_shorten_the_budget_but_never_extend_it() -> None:
    clock = Clock()

    with deadline_scope(10.0, clock=clock) as outer:
        with deadline_scope(25.0, clock=clock) as longer:
            assert longer is outer
            assert longer.remaining() == 10.0
        with deadline_scope(2.0, clock=clock) as shorter:
            assert shorter is not outer
            assert shorter.remaining() == 2.0
            assert current_deadline() is shorter
        assert current_deadline() is outer
