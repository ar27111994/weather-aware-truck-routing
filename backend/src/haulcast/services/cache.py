"""Layered read-through caching: in-process LRU, then a PostgreSQL TTL table, then the loader.

Three layers cooperate (API contract, "Caching layers"):

1. :class:`TtlLruCache`, a small per-instance cache for hot keys (no network, no database);
2. a PostgreSQL table per cache (``geocode_cache``, ``route_cache``) shared by every instance, with
   an ``expires_at`` TTL that expired rows never satisfy a read (the cleanup job deletes them);
3. *single-flight* (:mod:`haulcast.services.single_flight`): a miss claims a short lease on the key,
   re-checks the table (another request may have filled it meanwhile) and only then calls the
   loader. A stampede of identical requests results in one upstream call, and if that call fails
   the waiters in the process receive the same failure instead of retrying one after another.
   Nothing is held while the loader runs: no transaction, no lock, no pooled connection.

If the leader's work does not end within the time this request may wait (the request deadline),
the loader still runs (the request is served, just without stampede protection) and its result is
cached best-effort. A stored payload that no longer decodes (for example after a schema change) is
treated as a miss and overwritten.
"""

import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final

from django.db import models

from haulcast.observability import record_cache_outcome
from haulcast.services.single_flight import FlightTimeoutError, Job, single_flight

logger = logging.getLogger("haulcast.cache")

DEFAULT_LRU_ENTRIES: Final = 512
DEFAULT_LRU_TTL_S: Final = 3_600.0


def utc_now() -> datetime:
    """Return the current time as a timezone-aware UTC datetime (the default clock)."""
    return datetime.now(UTC)


class TtlLruCache[V]:
    """Thread-safe, size-bounded cache whose entries also expire after a per-entry TTL."""

    def __init__(
        self,
        max_entries: int = DEFAULT_LRU_ENTRIES,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """Create an empty cache holding at most ``max_entries`` entries (LRU eviction)."""
        self._max_entries = max_entries
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: OrderedDict[str, tuple[float, V]] = OrderedDict()

    def get(self, key: str) -> V | None:
        """Return the live value for ``key`` (marking it recently used), else ``None``."""
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            expires_at, value = entry
            if self._clock() >= expires_at:
                del self._entries[key]
                return None
            self._entries.move_to_end(key)
            return value

    def put(self, key: str, value: V, ttl_s: float) -> None:
        """Store ``value`` for ``ttl_s`` seconds, evicting the least recently used on overflow."""
        with self._lock:
            self._entries[key] = (self._clock() + ttl_s, value)
            self._entries.move_to_end(key)
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)

    def __len__(self) -> int:
        """Return the number of stored entries (including ones that may have expired)."""
        with self._lock:
            return len(self._entries)


@dataclass(frozen=True, slots=True)
class CacheSpec[V]:
    """What one cache stores: its name (lock namespace), provider label, TTL and JSON codec."""

    name: str
    provider: str
    ttl: timedelta
    encode: Callable[[V], object]
    decode: Callable[[object], V]


class JsonCache[V, M: models.Model]:
    """Read-through cache of ``V`` values stored as JSON in a ``(key, payload, ...)`` table."""

    def __init__(
        self,
        spec: CacheSpec[V],
        *,
        model: type[M],
        manager: models.Manager[M],
        lru: TtlLruCache[V] | None = None,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        """Bind ``spec`` to the table of ``model`` (fields ``key``, ``payload``, ...)."""
        self._spec = spec
        self._model = model
        self._manager = manager
        self._lru = lru if lru is not None else TtlLruCache[V]()
        self._clock = clock

    def get(self, key: str) -> V | None:
        """Return the cached value from memory or the table, or ``None`` (and count hit/miss)."""
        value = self._lookup(key)
        record_cache_outcome("hit" if value is not None else "miss")
        return value

    def _lookup(self, key: str) -> V | None:
        """Return the cached value from memory, else from the table (remembering it); no metrics."""
        value = self._lru.get(key)
        if value is None:
            stored = self._read(key)
            if stored is not None:
                value, remaining = stored
                self._remember(key, value, remaining)
        return value

    def put(self, key: str, value: V, *, ttl: timedelta | None = None) -> None:
        """Store ``value`` in the table (upsert) and in memory for ``ttl`` (default: the spec's)."""
        lifetime = self._spec.ttl if ttl is None else ttl
        now = self._clock()
        self._manager.bulk_create(
            [
                self._model(
                    key=key,
                    payload=self._spec.encode(value),
                    provider=self._spec.provider,
                    created_at=now,
                    expires_at=now + lifetime,
                )
            ],
            update_conflicts=True,
            unique_fields=["key"],
            update_fields=["payload", "provider", "created_at", "expires_at"],
        )
        self._remember(key, value, lifetime)

    def get_or_load(
        self,
        key: str,
        loader: Callable[[], V],
        *,
        ttl_for: Callable[[V], timedelta] | None = None,
    ) -> V:
        """Return the cached value for ``key``; on a miss call ``loader`` once per stampede.

        Exactly one outcome is counted per call: a ``hit`` when the value came from memory, the
        table or a concurrent request's load, a ``miss`` when this call ran the loader.
        ``ttl_for`` chooses how long a loaded value lives (default: the spec's), so an answer that
        may be a gap in the data can expire sooner than a solid one.
        """
        cached = self._lookup(key)
        if cached is not None:
            record_cache_outcome("hit")
            return cached
        led = False

        def load_and_store() -> V:
            nonlocal led
            led = True
            record_cache_outcome("miss")
            value = loader()
            self.put(key, value, ttl=None if ttl_for is None else ttl_for(value))
            return value

        try:
            value = single_flight.run(
                self._spec.name, key, Job(probe=lambda: self._lookup(key), work=load_and_store)
            )
        except FlightTimeoutError:
            logger.warning("cache_flight_timeout", extra={"event": "cache_unprotected_load"})
            return load_and_store()
        if not led:
            record_cache_outcome("hit")
        return value

    def _remember(self, key: str, value: V, lifetime: timedelta) -> None:
        """Keep ``value`` in memory for at most ``lifetime``: never longer than its entry lives."""
        self._lru.put(key, value, min(DEFAULT_LRU_TTL_S, lifetime.total_seconds()))

    def _read(self, key: str) -> tuple[V, timedelta] | None:
        """Return the stored value and how long it still lives, or ``None``."""
        now = self._clock()
        row = (
            self._manager.filter(key=key, expires_at__gt=now)
            .values_list("payload", "expires_at")
            .first()
        )
        if row is None:
            return None
        payload, expires_at = row
        try:
            return self._spec.decode(payload), expires_at - now
        except (KeyError, TypeError, ValueError):
            logger.warning("cache_payload_undecodable", extra={"event": "cache_decode_failed"})
            return None
