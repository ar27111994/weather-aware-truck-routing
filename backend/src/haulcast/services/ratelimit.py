"""Rate limiting: per-endpoint policies, an atomic PostgreSQL limiter and an in-process fallback.

Policies (API contract): ``POST /plans`` 6/min and 60/day, ``GET /heatmap`` 30/min, ``GET /geocode``
60/min, everything else 120/min, per client (see :mod:`haulcast.services.client_ip`). Each
policy is a GCRA token bucket whose capacity equals its quota, refilled continuously
(``limit`` tokens per ``window_s``). The authoritative decision is made in the database by
``app.rate_limit_take`` in one atomic statement: exact across threads and instances.

If the database is unreachable the limiter degrades to an in-process bucket with the same policy
(per instance, so weaker, but never *absent*); liveness checks use the in-process bucket only, so
they keep working while the database is down.
"""

import logging
import math
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from functools import cache
from typing import Final, Protocol

from django.db import Error as DatabaseError
from django.db import connection, transaction

logger = logging.getLogger("haulcast.ratelimit")

_MS_PER_S: Final = 1000.0
_MAX_LOCAL_BUCKETS: Final = 10_000


@dataclass(frozen=True, slots=True)
class RatePolicy:
    """``limit`` requests per ``window_s`` seconds; the bucket holds ``limit`` tokens."""

    name: str
    limit: int
    window_s: int


@dataclass(frozen=True, slots=True)
class RateRule:
    """All policies one endpoint is subject to (a request must satisfy every one)."""

    scope: str
    policies: tuple[RatePolicy, ...]
    local_only: bool = False
    """Use the in-process limiter only (no database access): for the liveness probe."""


PLANS: Final = RateRule("plans", (RatePolicy("minute", 6, 60), RatePolicy("day", 60, 86_400)))
HEATMAP: Final = RateRule("heatmap", (RatePolicy("minute", 30, 60),))
GEOCODE: Final = RateRule("geocode", (RatePolicy("minute", 60, 60),))
LIVENESS: Final = RateRule("liveness", (RatePolicy("minute", 120, 60),), local_only=True)
DEFAULT: Final = RateRule("default", (RatePolicy("minute", 120, 60),))

_GET_METHODS: Final = frozenset({"GET", "HEAD"})
_ROUTES: Final = (
    (frozenset({"POST"}), re.compile(r"/api/v1/plans/?"), PLANS),
    (_GET_METHODS, re.compile(r"/api/v1/plans/[^/]+/heatmap/?"), HEATMAP),
    (_GET_METHODS, re.compile(r"/api/v1/geocode/?"), GEOCODE),
    (_GET_METHODS, re.compile(r"/api/v1/health/?"), LIVENESS),
)


def rule_for(method: str, path: str) -> RateRule:
    """Return the :class:`RateRule` governing ``method`` + ``path`` (the default for the rest)."""
    for methods, pattern, rule in _ROUTES:
        if method in methods and pattern.fullmatch(path) is not None:
            return rule
    return DEFAULT


@dataclass(frozen=True, slots=True)
class BucketStatus:
    """State of one bucket after a decision: tokens left and time until it is full again."""

    policy: RatePolicy
    remaining: int
    reset_after_s: float


@dataclass(frozen=True, slots=True)
class RateDecision:
    """Outcome of taking one token from every bucket of a rule."""

    allowed: bool
    retry_after_s: float
    statuses: tuple[BucketStatus, ...]


class RateLimiter(Protocol):
    """Takes one token per policy of ``rule`` for the client identified by ``client_key``."""

    def take(self, client_key: str, rule: RateRule) -> RateDecision:
        """Return the decision; a denied request consumes nothing."""
        ...


class PostgresRateLimiter:
    """The authoritative limiter: ``app.rate_limit_take`` per policy, all-or-nothing."""

    def take(self, client_key: str, rule: RateRule) -> RateDecision:
        """Take one token from every policy's bucket, rolling back all of them on a denial."""
        statuses: list[BucketStatus] = []
        retry_after_s = 0.0
        permitted = True
        with transaction.atomic(), connection.cursor() as cursor:
            for policy in rule.policies:
                cursor.execute(
                    "SELECT allowed, retry_after_ms, remaining, reset_after_ms "
                    "FROM app.rate_limit_take(%s, %s, make_interval(secs => %s), %s, 1)",
                    [
                        f"{rule.scope}:{policy.name}:{client_key}",
                        policy.limit,
                        policy.window_s,
                        policy.limit,
                    ],
                )
                ((allowed, retry_ms, remaining, reset_ms),) = cursor.fetchall()
                statuses.append(BucketStatus(policy, remaining, reset_ms / _MS_PER_S))
                if not allowed:
                    permitted = False
                    retry_after_s = retry_ms / _MS_PER_S
                    # Tokens already taken from earlier policies of this request are given back.
                    transaction.set_rollback(True)
                    break
        return RateDecision(permitted, retry_after_s, tuple(statuses))


class InMemoryRateLimiter:
    """GCRA in process memory: per instance, thread-safe, bounded, with an injectable clock."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        max_buckets: int = _MAX_LOCAL_BUCKETS,
    ) -> None:
        """Create an empty limiter reading time from ``clock`` (seconds, monotonic)."""
        self._clock = clock
        self._max_buckets = max_buckets
        self._lock = threading.Lock()
        self._theoretical_arrival: dict[str, float] = {}

    def take(self, client_key: str, rule: RateRule) -> RateDecision:
        """Take one token from every policy's bucket, giving all back on a denial."""
        with self._lock:
            now = self._clock()
            self._prune(now)
            updates: dict[str, float] = {}
            statuses: list[BucketStatus] = []
            for policy in rule.policies:
                key = f"{rule.scope}:{policy.name}:{client_key}"
                interval = policy.window_s / policy.limit
                tat = self._theoretical_arrival.get(key, now)
                candidate = max(tat, now) + interval
                burst_s = policy.limit * interval
                if candidate > now + burst_s:
                    backlog = max(tat - now, 0.0)
                    statuses.append(self._status(policy, interval, backlog))
                    return RateDecision(
                        allowed=False,
                        retry_after_s=backlog + interval - burst_s,
                        statuses=tuple(statuses),
                    )
                updates[key] = candidate
                statuses.append(self._status(policy, interval, candidate - now))
            self._theoretical_arrival.update(updates)
        return RateDecision(allowed=True, retry_after_s=0.0, statuses=tuple(statuses))

    def __len__(self) -> int:
        """Return the number of tracked buckets (bounded: see :meth:`_prune`)."""
        with self._lock:
            return len(self._theoretical_arrival)

    @staticmethod
    def _status(policy: RatePolicy, interval: float, backlog_s: float) -> BucketStatus:
        remaining = max(math.floor((policy.limit * interval - backlog_s) / interval), 0)
        return BucketStatus(policy, remaining, backlog_s)

    def _prune(self, now: float) -> None:
        """Forget buckets that are full again; bounds memory under address-rotation abuse."""
        if len(self._theoretical_arrival) >= self._max_buckets:
            self._theoretical_arrival = {
                key: tat for key, tat in self._theoretical_arrival.items() if tat > now
            }


class RateLimitService:
    """Chooses the limiter: in-process for liveness, PostgreSQL (with fallback) otherwise."""

    def __init__(self, primary: RateLimiter, fallback: RateLimiter) -> None:
        """Wire the authoritative ``primary`` limiter and the degraded-mode ``fallback``."""
        self._primary = primary
        self._fallback = fallback

    def take(self, client_key: str, rule: RateRule) -> RateDecision:
        """Return the decision for one request of ``client_key`` under ``rule``."""
        if rule.local_only:
            return self._fallback.take(client_key, rule)
        try:
            return self._primary.take(client_key, rule)
        except DatabaseError:
            logger.warning("rate_limit_store_unavailable", extra={"event": "rate_limit_fallback"})
            return self._fallback.take(client_key, rule)


@cache
def rate_limit_service() -> RateLimitService:
    """The process-wide service (tests replace it via ``rate_limit_service.cache_clear``)."""
    return RateLimitService(PostgresRateLimiter(), InMemoryRateLimiter())
