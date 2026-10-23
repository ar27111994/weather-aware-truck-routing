"""The frozen wall clock of replay mode."""

from collections.abc import Callable
from datetime import datetime


def frozen_clock(instant: datetime) -> Callable[[], datetime]:
    """Return a wall clock that always tells ``instant``.

    Only wall clocks are frozen. Monotonic clocks (the rate limiter, the request deadlines, the
    pacing of retries) keep running: a limiter on a frozen clock would never refill and so would
    refuse every request after its burst until the process restarts.

    Raises:
        ValueError: ``instant`` carries no timezone.
    """
    if instant.utcoffset() is None:
        raise ValueError("a frozen clock needs a timezone-aware instant")

    def clock() -> datetime:
        return instant

    return clock
