"""Layered read-through caching: in-process LRU, PostgreSQL TTL table, single-flight loading."""

import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import pytest

from haulcast.observability import begin_request_metrics, end_request_metrics
from haulcast.services.cache import CacheSpec, JsonCache, TtlLruCache, utc_now
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


# --------------------------------------------------------------------------- per-entry lifetimes


def test_an_entry_can_live_shorter_than_the_spec_says() -> None:
    clock = Clock()
    _cache(clock).put("short", {"a": 1}, ttl=timedelta(minutes=1))

    assert GeocodeCache.objects.get(key="short").expires_at == NOON + timedelta(minutes=1)
    clock.now = NOON + timedelta(minutes=2)
    assert _cache(clock).get("short") is None, "a cold instance finds the row expired"


def test_the_in_process_copy_dies_with_its_entry_not_with_the_spec(clock: FakeClock) -> None:
    lru = TtlLruCache[dict[str, int]](clock=clock)
    _cache(lru=lru).put("short", {"a": 1}, ttl=timedelta(minutes=1))

    clock.advance(59)
    assert lru.get("short") == {"a": 1}
    clock.advance(2)
    assert lru.get("short") is None


def test_a_value_read_from_the_table_is_remembered_only_for_what_is_left_of_its_life(
    clock: FakeClock,
) -> None:
    wall = Clock()
    _cache(wall).put("short", {"a": 1}, ttl=timedelta(minutes=10))
    wall.now = NOON + timedelta(minutes=9)
    lru = TtlLruCache[dict[str, int]](clock=clock)

    assert _cache(wall, lru).get("short") == {"a": 1}  # a cold instance reads the row

    clock.advance(61)  # the row has one minute left: the copy must not outlive it
    assert lru.get("short") is None


def test_get_or_load_stores_a_loaded_value_for_the_lifetime_the_caller_chooses() -> None:
    cache = _cache()

    cache.get_or_load(
        "empty", dict, ttl_for=lambda value: timedelta(minutes=1) if not value else TTL
    )
    cache.get_or_load(
        "full", lambda: {"a": 1}, ttl_for=lambda value: timedelta(minutes=1) if not value else TTL
    )

    assert GeocodeCache.objects.get(key="empty").expires_at == NOON + timedelta(minutes=1)
    assert GeocodeCache.objects.get(key="full").expires_at == NOON + TTL
