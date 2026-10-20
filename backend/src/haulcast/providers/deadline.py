"""A request-scoped wall-clock deadline that every outbound call consults.

httpx bounds each *phase* of a call (connect, one read of a chunk, write, pool), never the call as
a whole: a slow-drip body or a chain of retries can run for many times the configured timeout. A
serverless function that is killed at ``maxDuration`` then answers with the platform's non-problem
504, and every degraded mode the application has (fallback providers, in-process limiters, clean
503s) is skipped. The fix is one budget for the whole request, decided where the request starts and
consumed wherever time is spent: :class:`~haulcast.providers.http.UpstreamClient` shortens every
attempt to what is left, refuses to retry or sleep across the end, and cuts a body that is still
arriving. Nothing here knows about HTTP; the module is a clock and a context variable.

Scopes nest, and an inner scope can only *shorten* the budget (a stage of the request gets less
than the request as a whole, never more).
"""

import math
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Final

MIN_ATTEMPT_S: Final = 0.25
"""Less time than this is left: an upstream cannot be connected to and answer in it."""


class Deadline:
    """A point in time on a monotonic clock, read as "seconds left"."""

    def __init__(self, seconds: float, *, clock: Callable[[], float] = time.monotonic) -> None:
        """Start a deadline ``seconds`` from now on ``clock`` (injectable for tests).

        Raises:
            ValueError: ``seconds`` is not positive and finite.
        """
        if not (math.isfinite(seconds) and seconds > 0):
            raise ValueError("a deadline needs a positive, finite budget in seconds")
        self._clock = clock
        self.expires_at = clock() + seconds

    def remaining(self) -> float:
        """Return the seconds left, never below zero."""
        return max(0.0, self.expires_at - self._clock())

    def expired(self) -> bool:
        """Return whether nothing is left."""
        return self.remaining() <= 0.0


_CURRENT: ContextVar[Deadline | None] = ContextVar("haulcast_deadline", default=None)


def current_deadline() -> Deadline | None:
    """Return the deadline of the enclosing scope, or ``None`` when there is none."""
    return _CURRENT.get()


@contextmanager
def deadline_scope(
    seconds: float, *, clock: Callable[[], float] = time.monotonic
) -> Iterator[Deadline]:
    """Bound everything done inside the ``with`` block to ``seconds`` (or what an outer scope has).

    An inner scope never extends an outer one: it yields the outer deadline itself when that ends
    sooner. The previous deadline is restored on exit, however the block ends.
    """
    outer = _CURRENT.get()
    own = Deadline(seconds, clock=clock)
    effective = outer if outer is not None and outer.expires_at <= own.expires_at else own
    token = _CURRENT.set(effective)
    try:
        yield effective
    finally:
        _CURRENT.reset(token)
