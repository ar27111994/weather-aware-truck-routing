"""Layered read-through caching: in-process LRU, PostgreSQL TTL table, single-flight loading."""

import logging
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from types import TracebackType

import pytest
from django.db import connections

import haulcast.services.cache as cache_module
from haulcast.observability import begin_request_metrics, end_request_metrics
from haulcast.services.cache import CacheSpec, JsonCache, TtlLruCache, utc_now
from haulcast.services.locks import LockUnavailableError
from haulcast.store.models import GeocodeCache
from tests.services.conftest import FakeClock

NOON = datetime(2026, 10, 20, 12, 0, tzinfo=UTC)
TTL = timedelta(minutes=10)


def _decode(payload: object) -> dict[str, int]:
    if not isinstance(payload, dict):
        raise TypeError("expected an object")
    return {str(key): value for key, value in payload.items() if isinstance(value, int)}


SPEC = CacheSpec[dict[str, int]](
    name="test-cache", provider="unit-test", ttl=TTL, encode=dict, decode=_decode
)


class NeverGranted:
    """A lock that is never granted: entering it fails the way an expired ``lock_timeout`` does."""

    def __init__(self, name: str) -> None:
        self.name = name

    def __enter__(self) -> None:
        raise LockUnavailableError(self.name)

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        return None


class Clock:
    """A settable wall clock for the cache's TTL arithmetic."""

    def __init__(self) -> None:
        self.now = NOON

    def __call__(self) -> datetime:
        return self.now


def _cache(
    clock: Callable[[], datetime] | None = None, lru: TtlLruCache[dict[str, int]] | None = None
) -> JsonCache[dict[str, int], GeocodeCache]:
    return JsonCache(
        SPEC, model=GeocodeCache, manager=GeocodeCache.objects, lru=lru, clock=clock or Clock()
    )


# --------------------------------------------------------------------------- the LRU


def test_the_lru_returns_what_was_stored_until_it_expires(clock: FakeClock) -> None:
    lru = TtlLruCache[str](clock=clock)
    lru.put("k", "v", ttl_s=10)

    assert lru.get("k") == "v"
    clock.advance(9.99)
    assert lru.get("k") == "v"
    clock.advance(0.01)
    assert lru.get("k") is None
    assert len(lru) == 0


def test_the_lru_has_no_value_for_an_unknown_key(clock: FakeClock) -> None:
    assert TtlLruCache[str](clock=clock).get("missing") is None


def test_the_lru_evicts_the_least_recently_used_entry(clock: FakeClock) -> None:
    lru = TtlLruCache[int](2, clock=clock)
    lru.put("a", 1, ttl_s=100)
    lru.put("b", 2, ttl_s=100)
    assert lru.get("a") == 1  # a is now more recent than b

    lru.put("c", 3, ttl_s=100)

    assert (lru.get("a"), lru.get("b"), lru.get("c")) == (1, None, 3)
    assert len(lru) == 2


def test_putting_a_key_again_replaces_its_value_and_restarts_its_ttl(clock: FakeClock) -> None:
    lru = TtlLruCache[int](clock=clock)
    lru.put("k", 1, ttl_s=10)
    clock.advance(8)
    lru.put("k", 2, ttl_s=10)
    clock.advance(8)

    assert lru.get("k") == 2
    assert len(lru) == 1


def test_the_clock_defaults_to_the_monotonic_clock() -> None:
    lru = TtlLruCache[int]()
    lru.put("k", 1, ttl_s=60)

    assert lru.get("k") == 1


def test_the_default_wall_clock_is_timezone_aware_utc() -> None:
    assert abs(utc_now() - datetime.now(UTC)) < timedelta(seconds=5)
    assert utc_now().utcoffset() == timedelta(0)


# --------------------------------------------------------------------------- the table cache


@pytest.mark.django_db
def test_a_missing_key_is_a_miss_and_is_counted() -> None:
    tokens = begin_request_metrics()

    value = _cache().get("absent")

    assert value is None
    assert end_request_metrics(tokens) == ((), ("miss",))


@pytest.mark.django_db
def test_a_stored_value_is_a_hit_and_is_counted() -> None:
    cache = _cache()
    cache.put("k", {"a": 1})
    tokens = begin_request_metrics()

    value = cache.get("k")

    assert value == {"a": 1}
    assert end_request_metrics(tokens) == ((), ("hit",))


@pytest.mark.django_db
def test_put_writes_the_row_with_provider_and_expiry() -> None:
    _cache().put("k", {"a": 1})

    row = GeocodeCache.objects.get(key="k")
    assert row.payload == {"a": 1}
    assert row.provider == "unit-test"
    assert row.expires_at == NOON + TTL


@pytest.mark.django_db
def test_putting_again_updates_the_single_row() -> None:
    clock = Clock()
    cache = _cache(clock)
    cache.put("k", {"a": 1})
    clock.now = NOON + timedelta(minutes=5)

    cache.put("k", {"a": 2})

    assert GeocodeCache.objects.count() == 1
    row = GeocodeCache.objects.get(key="k")
    assert row.payload == {"a": 2}
    assert row.expires_at == NOON + timedelta(minutes=15)


@pytest.mark.django_db
def test_another_instance_reads_what_one_instance_stored_and_remembers_it() -> None:
    _cache().put("k", {"a": 1})
    reader = _cache()

    first = reader.get("k")
    GeocodeCache.objects.all().delete()
    second = reader.get("k")  # served from the reader's own LRU now

    assert first == second == {"a": 1}


@pytest.mark.django_db
def test_an_expired_row_never_satisfies_a_read() -> None:
    clock = Clock()
    _cache(clock).put("k", {"a": 1})
    clock.now = NOON + TTL  # expires_at > now is required: the boundary is already stale

    assert _cache(clock).get("k") is None
    assert GeocodeCache.objects.filter(key="k").exists()  # cleanup, not reads, deletes rows


@pytest.mark.django_db
def test_an_expired_row_is_replaced_by_the_next_load() -> None:
    clock = Clock()
    _cache(clock).put("k", {"a": 1})
    clock.now = NOON + timedelta(hours=1)

    value = _cache(clock).get_or_load("k", lambda: {"a": 2})

    assert value == {"a": 2}
    assert GeocodeCache.objects.get(key="k").expires_at == NOON + timedelta(hours=1) + TTL


@pytest.mark.django_db
def test_the_lru_never_outlives_the_cache_ttl_or_an_hour(clock: FakeClock) -> None:
    lru = TtlLruCache[dict[str, int]](clock=clock)
    cache = _cache(lru=lru)
    cache.put("k", {"a": 1})
    GeocodeCache.objects.all().delete()  # only the LRU can still answer

    clock.advance(TTL.total_seconds() - 1)
    assert cache.get("k") == {"a": 1}
    clock.advance(2)
    assert cache.get("k") is None


@pytest.mark.django_db
def test_an_undecodable_stored_payload_is_a_miss_that_the_next_load_repairs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    GeocodeCache.objects.create(
        key="k", payload=["not", "an", "object"], provider="old", expires_at=NOON + TTL
    )
    cache = _cache()

    with caplog.at_level(logging.WARNING, logger="haulcast.cache"):
        assert cache.get("k") is None
    value = cache.get_or_load("k", lambda: {"a": 3})

    assert "cache_payload_undecodable" in caplog.text
    assert value == {"a": 3}
    assert GeocodeCache.objects.get(key="k").payload == {"a": 3}


# --------------------------------------------------------------------------- loading


@pytest.mark.django_db
def test_a_miss_calls_the_loader_once_and_a_hit_never_calls_it() -> None:
    cache = _cache()
    calls: list[str] = []

    def loader() -> dict[str, int]:
        calls.append("load")
        return {"a": 1}

    first = cache.get_or_load("k", loader)
    second = cache.get_or_load("k", loader)
    third = _cache().get_or_load("k", loader)  # a cold instance finds the row

    assert first == second == third == {"a": 1}
    assert calls == ["load"]
    assert GeocodeCache.objects.filter(key="k").count() == 1


@pytest.mark.django_db
def test_a_loader_failure_caches_nothing_and_propagates() -> None:
    def broken() -> dict[str, int]:
        raise RuntimeError("upstream exploded")

    with pytest.raises(RuntimeError, match="upstream exploded"):
        _cache().get_or_load("k", broken)

    assert not GeocodeCache.objects.filter(key="k").exists()


@pytest.mark.django_db
def test_a_value_filled_while_waiting_for_the_lock_is_used_without_loading(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    @contextmanager
    def lock_taken_after_a_competitor_filled_the_cache(name: str) -> Iterator[None]:
        assert name == "test-cache:k"
        _cache().put("k", {"a": 99})  # what the request that held the lock stored
        yield

    monkeypatch.setattr(
        cache_module, "advisory_lock", lock_taken_after_a_competitor_filled_the_cache
    )

    def must_not_run() -> dict[str, int]:
        pytest.fail("the loader must not run when the cache was filled while waiting")

    assert _cache().get_or_load("k", must_not_run) == {"a": 99}


@pytest.mark.django_db
def test_when_the_lock_cannot_be_had_the_loader_still_runs_and_the_result_is_cached(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(cache_module, "advisory_lock", NeverGranted)

    with caplog.at_level(logging.WARNING, logger="haulcast.cache"):
        value = _cache().get_or_load("k", lambda: {"a": 5})

    assert value == {"a": 5}
    assert "cache_lock_unavailable" in caplog.text
    assert GeocodeCache.objects.get(key="k").payload == {"a": 5}


@pytest.mark.django_db(transaction=True)
def test_a_stampede_of_identical_requests_calls_the_loader_exactly_once() -> None:
    """Single-flight: while one request loads, the rest wait on the advisory lock and then hit."""
    waiters = 5
    cache = _cache()
    loader_calls: list[int] = []
    loader_started = threading.Event()
    release_loader = threading.Event()

    def loader() -> dict[str, int]:
        loader_calls.append(1)
        loader_started.set()
        assert release_loader.wait(timeout=30)
        return {"a": 7}

    def request(_: int) -> dict[str, int]:
        try:
            return cache.get_or_load("stampede", loader)
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=waiters + 1) as pool:
        first = pool.submit(request, 0)
        assert loader_started.wait(timeout=30)
        rest = [pool.submit(request, index) for index in range(1, waiters + 1)]
        _wait_until_blocked_on_advisory_locks(waiters)
        release_loader.set()
        results = [future.result(timeout=60) for future in [first, *rest]]

    assert results == [{"a": 7}] * (waiters + 1)
    assert loader_calls == [1]


def _wait_until_blocked_on_advisory_locks(expected: int) -> None:
    """Poll PostgreSQL until ``expected`` sessions wait for an advisory lock (bounded wait)."""
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        with connections["default"].cursor() as cursor:
            cursor.execute(
                "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted"
            )
            row = cursor.fetchone()
        if row is not None and row[0] >= expected:
            return
        time.sleep(0.05)
    pytest.fail(f"fewer than {expected} sessions ever waited for the advisory lock")
