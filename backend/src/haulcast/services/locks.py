"""Cross-instance mutual exclusion on PostgreSQL advisory locks (single-flight for cache fills).

When a cache entry is missing, many concurrent requests would otherwise all call the upstream. The
first takes the lock for that key and fills the cache; the others wait, then find the entry
and never call the upstream. Transaction-level locks (``pg_advisory_xact_lock``) are the
only kind that is safe behind a transaction-mode pooler such as Supavisor: a session-level
lock could outlive the backend connection a client is routed to. The lock is released when
the surrounding transaction ends, so the work done under it (including the cache write) is
atomic with it.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Final

from django.db import OperationalError, connection, transaction

DEFAULT_LOCK_TIMEOUT_S: Final = 15.0


class LockUnavailableError(Exception):
    """The advisory lock could not be taken within the timeout (callers proceed unlocked)."""


@contextmanager
def advisory_lock(name: str, *, timeout_s: float = DEFAULT_LOCK_TIMEOUT_S) -> Iterator[None]:
    """Hold the advisory lock ``name`` for the duration of the ``with`` block (in a transaction).

    Raises:
        LockUnavailableError: another transaction held the lock for longer than ``timeout_s``.
    """
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT set_config('lock_timeout', %s, true)", [f"{round(timeout_s * 1000)}ms"]
            )
            try:
                cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", [name])
            except OperationalError as exc:
                raise LockUnavailableError(name) from exc
        yield
