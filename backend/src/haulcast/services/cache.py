"""Layered read-through caching: in-process LRU, then a PostgreSQL TTL table, then the loader.

Three layers cooperate (API contract, "Caching layers"):

1. :class:`TtlLruCache`, a small per-instance cache for hot keys (no network, no database);
2. a PostgreSQL table per cache (``geocode_cache``, ``route_cache``) shared by every instance, with
   an ``expires_at`` TTL that expired rows never satisfy a read (the cleanup job deletes them);
3. *single-flight*: a miss takes a transaction-level advisory lock on the key, re-checks the table
   (another request may have filled it while this one waited) and only then calls the loader. A
   stampede of identical requests therefore results in exactly one upstream call.

If the lock cannot be taken in time the loader still runs (the request is served, just without
stampede protection) and its result is cached best-effort. A stored payload that no longer decodes
(for example after a schema change) is treated as a miss and overwritten.
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
from haulcast.services.locks import LockUnavailableError, advisory_lock

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
        value = self._lru.get(key)
        if value is None:
            value = self._read(key)
            if value is not None:
                self._remember(key, value)
        record_cache_outcome("hit" if value is not None else "miss")
        return value

    def put(self, key: str, value: V) -> None:
        """Store ``value`` in the table (upsert) and in memory."""
        now = self._clock()
        self._manager.bulk_create(
            [
                self._model(
                    key=key,
                    payload=self._spec.encode(value),
                    provider=self._spec.provider,
                    created_at=now,
                    expires_at=now + self._spec.ttl,
                )
            ],
            update_conflicts=True,
            unique_fields=["key"],
            update_fields=["payload", "provider", "created_at", "expires_at"],
        )
        self._remember(key, value)

    def get_or_load(self, key: str, loader: Callable[[], V]) -> V:
        """Return the cached value for ``key``; on a miss call ``loader`` once per stampede."""
        cached = self.get(key)
        if cached is not None:
            return cached
        try:
            with advisory_lock(f"{self._spec.name}:{key}"):
                cached = self._read(key)
                if cached is not None:
                    self._remember(key, cached)
                    return cached
                value = loader()
                self.put(key, value)
                return value
        except LockUnavailableError:
            logger.warning("cache_lock_unavailable", extra={"event": "cache_unlocked_load"})
            value = loader()
            self.put(key, value)
            return value

    def _remember(self, key: str, value: V) -> None:
        self._lru.put(key, value, min(DEFAULT_LRU_TTL_S, self._spec.ttl.total_seconds()))

    def _read(self, key: str) -> V | None:
        payload = (
            self._manager.filter(key=key, expires_at__gt=self._clock())
            .values_list("payload", flat=True)
            .first()
        )
        if payload is None:
            return None
        try:
            return self._spec.decode(payload)
        except (KeyError, TypeError, ValueError):
            logger.warning("cache_payload_undecodable", extra={"event": "cache_decode_failed"})
            return None
