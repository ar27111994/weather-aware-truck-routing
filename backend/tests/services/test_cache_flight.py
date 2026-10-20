"""Read-through loading on lease-based single-flight (R2-01, R2-10, R2-11, R2-34).

``JsonCache.get_or_load`` must coalesce a stampede into one loader call, share the leader's failure
with the waiters, and hold no transaction, lock or pooled connection while the loader (an upstream
call) runs. The primitive's own properties are pinned in ``test_single_flight.py``; these tests
pin that the cache wires it correctly.
"""

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from django.db import connection, connections
from django.utils import timezone

from haulcast.observability import begin_request_metrics, end_request_metrics
from haulcast.providers.deadline import deadline_scope
from haulcast.services.cache import CacheSpec, JsonCache
from haulcast.services.single_flight import lease_key
from haulcast.store.models import GeocodeCache, SingleFlightLease

pytestmark = pytest.mark.django_db(transaction=True)

TTL = timedelta(minutes=10)


def _decode(payload: object) -> dict[str, int]:
    if not isinstance(payload, dict):
        raise TypeError("expected an object")
    return {str(key): value for key, value in payload.items() if isinstance(value, int)}


SPEC = CacheSpec[dict[str, int]](
    name="flight-cache", provider="unit-test", ttl=TTL, encode=dict, decode=_decode
)


def _cache() -> JsonCache[dict[str, int], GeocodeCache]:
    return JsonCache(SPEC, model=GeocodeCache, manager=GeocodeCache.objects)


def _hold_lease_elsewhere(key: str, *, seconds: float) -> None:
    SingleFlightLease.objects.update_or_create(
        key=lease_key(SPEC.name, key),
        defaults={
            "holder": "another-instance",
            "expires_at": timezone.now() + timedelta(seconds=seconds),
        },
    )


def _end_lease_after(delay_s: float, key: str, *, storing: dict[str, int] | None = None) -> None:
    """In a timer thread: optionally store a value (the leader's result), then end the lease."""

    def finish() -> None:
        try:
            if storing is not None:
                _cache().put(key, storing)
            SingleFlightLease.objects.filter(key=lease_key(SPEC.name, key)).delete()
        finally:
            connections.close_all()

    threading.Timer(delay_s, finish).start()


# --------------------------------------------------------------------------- holding nothing


def test_no_transaction_is_open_while_the_loader_runs() -> None:
    seen: list[bool] = []

    def loader() -> dict[str, int]:
        seen.append(connection.in_atomic_block)
        return {"a": 1}

    _cache().get_or_load("k", loader)

    # R2-11: the loader (an upstream call) used to run inside the lock's transaction, pinning a
    # pooled server connection for as long as the upstream took.
    assert seen == [False]


# --------------------------------------------------------------------------- stampedes


def _stampede(
    loader: object, callers: int, key: str = "stampede"
) -> tuple[list[object], list[int]]:
    """Release ``callers`` identical requests behind one slow loader; return outcomes, calls."""
    cache = _cache()
    calls: list[int] = []
    started = threading.Event()
    release = threading.Event()

    def slow_loader() -> dict[str, int]:
        calls.append(1)
        started.set()
        assert release.wait(timeout=30)
        assert callable(loader)
        outcome = loader()
        assert isinstance(outcome, dict)
        return outcome

    def request(_index: int) -> dict[str, int]:
        try:
            return cache.get_or_load(key, slow_loader)
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=callers) as pool:
        leader = pool.submit(request, 0)
        assert started.wait(timeout=30)
        followers = [pool.submit(request, index) for index in range(1, callers)]
        time.sleep(0.3)  # a follower that is late simply hits the table: the outcome is the same
        release.set()
        outcomes: list[object] = []
        for future in [leader, *followers]:
            error = future.exception(timeout=60)
            outcomes.append(error if error is not None else future.result())
    return outcomes, calls


def test_a_stampede_of_identical_requests_calls_the_loader_exactly_once() -> None:
    outcomes, calls = _stampede(lambda: {"a": 7}, callers=6)

    assert outcomes == [{"a": 7}] * 6
    assert calls == [1]


def test_a_stampede_behind_a_failing_loader_fails_fast_with_one_loader_call() -> None:
    def failing() -> dict[str, int]:
        raise RuntimeError("upstream is down")

    outcomes, calls = _stampede(failing, callers=5)

    # R2-10 / probe P6: five waiters used to make five loader calls, one after another, each
    # failing after the previous one (the last at 5.5 s).
    assert calls == [1]
    assert all(isinstance(outcome, RuntimeError) for outcome in outcomes)
    assert len({id(outcome) for outcome in outcomes}) == 1


def test_nothing_is_cached_when_the_loader_fails() -> None:
    def broken() -> dict[str, int]:
        raise RuntimeError("upstream exploded")

    with pytest.raises(RuntimeError, match="upstream exploded"):
        _cache().get_or_load("k", broken)

    assert not GeocodeCache.objects.filter(key="k").exists()
    assert SingleFlightLease.objects.count() == 0


# --------------------------------------------------------------------------- other instances


def test_a_value_another_instance_stores_while_we_wait_is_used_without_loading() -> None:
    _hold_lease_elsewhere("k", seconds=60)
    _end_lease_after(0.4, "k", storing={"a": 99})

    def must_not_run() -> dict[str, int]:
        pytest.fail("another instance produced the value while this one waited")

    assert _cache().get_or_load("k", must_not_run) == {"a": 99}


def test_when_the_wait_runs_out_the_loader_still_runs_and_the_result_is_cached(
    caplog: pytest.LogCaptureFixture,
) -> None:
    _hold_lease_elsewhere("k", seconds=60)

    started = time.monotonic()
    with caplog.at_level(logging.WARNING, logger="haulcast.cache"), deadline_scope(0.5):
        value = _cache().get_or_load("k", lambda: {"a": 5})

    assert value == {"a": 5}
    assert time.monotonic() - started < 5  # bounded by the request deadline, not by FLIGHT_WAIT_S
    assert "cache_flight_timeout" in caplog.text
    assert GeocodeCache.objects.get(key="k").payload == {"a": 5}


# --------------------------------------------------------------------------- metrics


def test_the_request_that_loads_counts_a_miss_and_nothing_else() -> None:
    tokens = begin_request_metrics()
    _cache().get_or_load("k", lambda: {"a": 1})

    assert end_request_metrics(tokens) == ((), ("miss",))


def test_a_value_found_while_waiting_counts_as_a_hit_not_a_miss() -> None:
    _hold_lease_elsewhere("k", seconds=60)
    _end_lease_after(0.4, "k", storing={"a": 2})
    tokens = begin_request_metrics()

    _cache().get_or_load("k", lambda: {"a": 0})

    # It used to count a miss (the first lookup) and never the hit it ended up being.
    assert end_request_metrics(tokens) == ((), ("hit",))


def test_a_plain_hit_counts_exactly_one_hit() -> None:
    cache = _cache()
    cache.put("k", {"a": 3})
    tokens = begin_request_metrics()

    cache.get_or_load("k", lambda: {"a": 0})

    assert end_request_metrics(tokens) == ((), ("hit",))
