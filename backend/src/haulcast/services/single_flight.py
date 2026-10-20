"""Single-flight across instances without holding a lock, a transaction or a connection.

When many requests need the same expensive thing (a plan, a route, a forecast fill), one should
compute it and the others should use its result. The previous design took a PostgreSQL advisory
lock *inside a transaction* for the whole computation, which pinned one pooled connection (and, with
the budget taken inside, three shared row locks) for as long as the upstream call took: fills for
different windows serialised globally (probe P3) and a fill slower than the lock timeout turned
the next one into a 500 (probe P4). Behind a transaction pooler a held transaction is a held server
connection, and the free plan has very few.

This module coordinates with a **lease row** instead (``single_flight_lease``): claiming it is one
short autocommit statement, releasing it another, and the work in between holds nothing at all.

* *Different work never queues*: leases are per key, nothing is shared.
* *Identical work coalesces*. Inside a process, callers wait on the leader's in-flight record (no
  database traffic) and receive its failure too, so an outage costs one upstream attempt, not one
  per waiter (R2-10). Across instances, a follower polls the lease with a short backoff until it is
  released or expires, then ``probe`` s for the value the leader stored.
* *A dead leader frees the work*: the lease has an expiry on the database clock; whoever finds it
  expired takes it over.
* *Waiting is bounded*: by ``wait_s`` and by the request's deadline. A follower that gives up gets
  :class:`FlightTimeoutError` and decides what to do (serve unprotected, or answer "retry shortly").

``probe`` returns the finished value (anything but ``None``) when somebody has already produced it,
``work`` produces it (and stores it where ``probe`` finds it). ``probe`` runs once after the claim,
because the previous leader may have stored the value just before releasing.
"""

import hashlib
import logging
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Final

from django.db import DatabaseError, connection

from haulcast.config.timeouts import FLIGHT_LEASE_S, FLIGHT_WAIT_S
from haulcast.providers.deadline import current_deadline

logger = logging.getLogger("haulcast.flights")

_POLL_START_S: Final = 0.05
_POLL_CAP_S: Final = 0.5
_DIGEST_CHARS: Final = 40

_CLAIM: Final = """
INSERT INTO app.single_flight_lease AS lease (key, holder, expires_at)
VALUES (%s, %s, clock_timestamp() + make_interval(secs => %s))
ON CONFLICT (key) DO UPDATE
    SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
    WHERE lease.expires_at <= clock_timestamp()
RETURNING holder
"""
_HELD: Final = (
    "SELECT 1 FROM app.single_flight_lease WHERE key = %s AND expires_at > clock_timestamp()"
)
_RELEASE: Final = "DELETE FROM app.single_flight_lease WHERE key = %s AND holder = %s"


class FlightTimeoutError(Exception):
    """The work somebody else leads did not end within the time this caller may wait."""


def lease_key(kind: str, identity: str) -> str:
    """Return the lease key of ``identity`` under ``kind``: a readable prefix and a short digest.

    The digest keeps the key a fixed, small size however long (or hostile) the identity is, and
    keeps raw request text out of the table.
    """
    digest = hashlib.sha256(identity.encode()).hexdigest()[:_DIGEST_CHARS]
    return f"{kind}:{digest}"


@dataclass(frozen=True, slots=True)
class Job[T]:
    """One piece of work to coalesce, and how long it may take.

    ``probe`` returns the finished value when somebody has already produced it, else ``None``;
    ``work`` produces the value and stores it where ``probe`` will find it. ``lease_s`` is how long
    the leader may run before others take it for dead; ``wait_s`` is how long a caller waits for
    somebody else's work (never beyond the request deadline).
    """

    probe: Callable[[], T | None]
    work: Callable[[], T]
    lease_s: float = FLIGHT_LEASE_S
    wait_s: float = FLIGHT_WAIT_S


@dataclass(slots=True)
class _InFlight:
    """One computation running in this process: its end, and the failure it ended with."""

    finished: threading.Event = field(default_factory=threading.Event)
    error: Exception | None = None


class SingleFlight:
    """Coalesces identical work inside a process and across instances (see the module docs).

    ``clock``, ``sleep`` and ``new_holder`` are injectable for tests. One instance per process is
    the norm (:data:`single_flight`); two instances in a test stand for two function instances.
    """

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        new_holder: Callable[[], str] = lambda: secrets.token_hex(8),
    ) -> None:
        """Create an empty registry of in-flight work."""
        self._clock = clock
        self._sleep = sleep
        self._new_holder = new_holder
        self._guard = threading.Lock()
        self._flights: dict[str, _InFlight] = {}

    def run[T](self, kind: str, identity: str, job: Job[T]) -> T:
        """Return the value of ``job`` for ``kind``/``identity``, computing it once at a time.

        Raises:
            FlightTimeoutError: somebody else's work did not end in time.
            Exception: whatever the leader's ``work`` raised (every waiter receives it).
        """
        key = lease_key(kind, identity)
        wait = self._bounded(job.wait_s)
        while True:
            flight, leading = self._enter(key)
            if leading:
                return self._lead_and_publish(flight, key, job, wait)
            if not flight.finished.wait(timeout=wait):
                raise FlightTimeoutError(key)
            if flight.error is not None:
                raise flight.error
            found = job.probe()
            if found is not None:
                return found
            # The leader ended without leaving a value anybody can read: take the lead.

    @staticmethod
    def _bounded(wait_s: float) -> float:
        deadline = current_deadline()
        return wait_s if deadline is None else min(wait_s, deadline.remaining())

    def _enter(self, key: str) -> tuple[_InFlight, bool]:
        """Join the computation in this process, or register as its leader."""
        with self._guard:
            flight = self._flights.get(key)
            if flight is not None:
                return flight, False
            flight = self._flights[key] = _InFlight()
            return flight, True

    def _lead_and_publish[T](self, flight: _InFlight, key: str, job: Job[T], wait: float) -> T:
        try:
            return self._lead(key, job, wait)
        except Exception as exc:
            flight.error = exc
            raise
        finally:
            with self._guard:
                del self._flights[key]
            flight.finished.set()

    def _lead[T](self, key: str, job: Job[T], wait: float) -> T:
        """Claim the lease (waiting for another instance's lease to end), then probe or work."""
        give_up_at = self._clock() + wait
        while True:
            holder = self._new_holder()
            if self._claim(key, holder, job.lease_s):
                try:
                    found = job.probe()
                    return found if found is not None else job.work()
                finally:
                    self._release(key, holder)
            if not self._wait_until_released(key, give_up_at):
                raise FlightTimeoutError(key)
            found = job.probe()
            if found is not None:
                return found

    @staticmethod
    def _claim(key: str, holder: str, lease_s: float) -> bool:
        with connection.cursor() as cursor:
            cursor.execute(_CLAIM, [key, holder, lease_s])
            row = cursor.fetchone()
        return row is not None and row[0] == holder

    def _wait_until_released(self, key: str, give_up_at: float) -> bool:
        """Poll until nobody holds a live lease on ``key``; ``False`` when the time is up."""
        delay = _POLL_START_S
        while (remaining := give_up_at - self._clock()) > 0:
            self._sleep(min(delay, remaining))
            if not self._held(key):
                return True
            delay = min(delay * 2, _POLL_CAP_S)
        return False

    @staticmethod
    def _held(key: str) -> bool:
        with connection.cursor() as cursor:
            cursor.execute(_HELD, [key])
            return cursor.fetchone() is not None

    @staticmethod
    def _release(key: str, holder: str) -> None:
        """Give the lease back.

        Failing to is logged and never raised: it would hide the work's own outcome, and the lease
        expires by itself.
        """
        try:
            with connection.cursor() as cursor:
                cursor.execute(_RELEASE, [key, holder])
        except DatabaseError:
            logger.warning("flight_release_failed", extra={"event": "flight_release_failed"})


single_flight: Final = SingleFlight()
"""The process-wide instance every use case shares."""
