"""A minimum-interval gate that spaces calls to fair-use public servers.

Valhalla's and OSRM's public demo servers ask for at most one call per second per client, and
Haulcast's contract says calls to them are strictly sequential and at least a second apart. The
gate enforces that **inside one process**: callers block (one at a time) until the interval since
the previous call was released has passed.

It is deliberately not more than that. Serverless instances each hold their own gate, and on
Vercel they share egress addresses, so two instances can call the same server within a second of
each other. The guarantee that holds between instances is the shared ``ROUTING`` budget of
``haulcast.services.budget`` (at most 40 calls per minute in total); the gate only keeps one
process from bursting.

The wait is part of the request's time budget: when the interval cannot be waited out and still
leave time for the call itself, the gate refuses at once instead of sleeping past the end of the
request.
"""

import math
import threading
import time
from collections.abc import Callable

from haulcast.providers.deadline import MIN_ATTEMPT_S, current_deadline
from haulcast.providers.errors import DeadlineExceededError


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
        name: str = "routing",
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        """Set the interval in seconds, the provider ``name`` to report and the time source.

        Raises:
            ValueError: ``min_interval_s`` is negative or not finite.
        """
        if not (math.isfinite(min_interval_s) and min_interval_s >= 0):
            raise ValueError("min_interval_s must be a finite, non-negative number")
        self._min_interval_s = min_interval_s
        self._name = name
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._released_at: float | None = None

    def wait(self) -> None:
        """Block until a call may start, then record that it did.

        Raises:
            DeadlineExceededError: the request's deadline leaves too little time to wait out the
                interval and still make the call (nothing is slept, the slot is not consumed).
        """
        with self._lock:
            if self._released_at is not None:
                needed = self._released_at + self._min_interval_s - self._clock()
                if needed > 0:
                    self._refuse_if_it_outlasts_the_deadline(needed)
                # A sleep can return early; keep waiting until the interval has really passed.
                while (remaining := self._released_at + self._min_interval_s - self._clock()) > 0:
                    self._sleep(remaining)
            self._released_at = self._clock()

    def _refuse_if_it_outlasts_the_deadline(self, needed: float) -> None:
        deadline = current_deadline()
        if deadline is not None and needed + MIN_ATTEMPT_S > deadline.remaining():
            raise DeadlineExceededError(
                self._name, "too little time left to keep the minimum interval between calls"
            )
