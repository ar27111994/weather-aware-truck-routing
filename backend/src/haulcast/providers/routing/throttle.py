"""A minimum-interval gate that spaces calls to fair-use public servers.

Valhalla's and OSRM's public demo servers ask for at most one call per second per client, and
Haulcast's contract says calls to them are strictly sequential and at least a second apart. The
gate enforces that inside one process: callers block (one at a time) until the interval since the
previous call was released has passed. Serverless instances each have their own gate, which is
what the per-IP fair-use policies are measured against anyway.
"""

import math
import threading
import time
from collections.abc import Callable


class MinIntervalGate:
    """Releases callers at least ``min_interval_s`` apart, measured between call starts.

    ``wait()`` returns immediately for the first caller; every later caller blocks until the
    interval since the previous caller was released has elapsed, so a caller that goes on to
    start its request right after ``wait()`` returns starts it at least ``min_interval_s`` after
    the previous one. Thread-safe: concurrent callers queue up on a lock and are released one
    interval apart. ``clock`` and ``sleep`` are injectable so tests run without waiting.
    """

    def __init__(
        self,
        min_interval_s: float,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        """Set the interval in seconds and the time source and sleeper to use.

        Raises:
            ValueError: ``min_interval_s`` is negative or not finite.
        """
        if not (math.isfinite(min_interval_s) and min_interval_s >= 0):
            raise ValueError("min_interval_s must be a finite, non-negative number")
        self._min_interval_s = min_interval_s
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._released_at: float | None = None

    def wait(self) -> None:
        """Block until a call may start, then record that it did."""
        with self._lock:
            if self._released_at is not None:
                # A sleep can return early; keep waiting until the interval has really passed.
                while (remaining := self._released_at + self._min_interval_s - self._clock()) > 0:
                    self._sleep(remaining)
            self._released_at = self._clock()
