"""Weather fills on lease-based single-flight: nothing is held across the provider call (R2-01).

Probe P3 of the review: two fills for *different* windows serialised globally (the second fetch
began at 4.4 s instead of 1.3 s) because the budget's row locks were held by the fill's transaction
for the whole upstream call. Probe P4: a fill slower than the 15 s lock timeout made the next one
fail with an uncaught ``OperationalError`` (a 500). These tests pin the mechanism with real threads
against real PostgreSQL: while one fill is *inside* the provider call, other fills proceed and no
transaction is open (``test_weather_attempts`` covers the budget draws of the real client).
"""

import logging
import threading
import time
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from django.db import connection, connections

from haulcast.problems import ProblemError
from haulcast.providers.deadline import deadline_scope
from haulcast.providers.errors import ProviderUnavailableError
from haulcast.providers.weather.base import HourlyForecast, HourWindow, LatticePoint
from haulcast.services.weather import WeatherService
from haulcast.store.models import WeatherCache
from tests.services.test_weather import CONFIG, DENVER, SLC, START, Clock, forecast, window

pytestmark = pytest.mark.django_db(transaction=True)

ONE_HOUR_LATER = START + timedelta(hours=1)
WAIT_S = 30


class GatedProvider:
    """A weather provider whose first ``gated`` fetches wait until the test lets them go."""

    name = "gated"
    model = "best_match"
    max_points = 250

    def __init__(self, *, gated: int = 1_000, failure: Exception | None = None) -> None:
        self.gated = gated
        self.failure = failure
        self.calls: list[tuple[LatticePoint, ...]] = []
        self.open_transactions: list[bool] = []
        self.began = threading.Semaphore(0)
        self.release = threading.Event()

    def fetch(
        self, points: Sequence[LatticePoint], window: HourWindow
    ) -> Mapping[LatticePoint, HourlyForecast]:
        self.calls.append(tuple(points))
        self.open_transactions.append(connection.in_atomic_block)
        index = len(self.calls)
        self.began.release()
        if index <= self.gated:
            assert self.release.wait(timeout=WAIT_S)
        if self.failure is not None:
            raise self.failure
        return {point: forecast(point, window.hours, window.start, self.model) for point in points}


def make(provider: GatedProvider) -> WeatherService:
    return WeatherService(provider, CONFIG, clock=Clock())


def hourly_in_thread(
    service: WeatherService, points: Sequence[LatticePoint], span: HourWindow
) -> dict[LatticePoint, HourlyForecast]:
    try:
        return service.hourly(points, span)
    finally:
        connections.close_all()


def wait_for_fetches(provider: GatedProvider, count: int) -> None:
    for _ in range(count):
        assert provider.began.acquire(timeout=WAIT_S), "a fill never reached the provider"


# --------------------------------------------------------------------------- holding nothing


def test_no_transaction_is_open_while_the_provider_is_called() -> None:
    provider = GatedProvider(gated=0)

    make(provider).hourly([DENVER], window())

    assert provider.open_transactions == [False]


# --------------------------------------------------------------------------- unrelated fills


@pytest.mark.parametrize(
    ("first", "second"),
    [
        pytest.param(
            ([DENVER], window(3, START)), ([DENVER], window(3, ONE_HOUR_LATER)), id="windows"
        ),
        pytest.param(([DENVER], window(3, START)), ([SLC], window(3, START)), id="corridors"),
    ],
)
def test_unrelated_fills_are_inside_the_provider_at_the_same_time(
    first: tuple[list[LatticePoint], HourWindow], second: tuple[list[LatticePoint], HourWindow]
) -> None:
    provider = GatedProvider()
    service = make(provider)

    with ThreadPoolExecutor(max_workers=2) as pool:
        fills = [pool.submit(hourly_in_thread, service, *first)]
        wait_for_fetches(provider, 1)
        fills.append(pool.submit(hourly_in_thread, service, *second))
        wait_for_fetches(provider, 1)  # the second began while the first is still in flight
        provider.release.set()
        for fill in fills:
            fill.result(timeout=WAIT_S)

    assert len(provider.calls) == 2


# --------------------------------------------------------------------------- identical fills


def _race(
    service: WeatherService, provider: GatedProvider, requests: Sequence[Sequence[LatticePoint]]
) -> list[object]:
    """Start the first request, wait until it is in the provider, then release the others."""
    with ThreadPoolExecutor(max_workers=len(requests)) as pool:
        futures = [pool.submit(hourly_in_thread, service, requests[0], window())]
        wait_for_fetches(provider, 1)
        futures.extend(pool.submit(hourly_in_thread, service, r, window()) for r in requests[1:])
        time.sleep(0.4)  # the rest are waiting on the flight (or, if late, will find the rows)
        provider.release.set()
        outcomes: list[object] = []
        for future in futures:
            error = future.exception(timeout=WAIT_S)
            outcomes.append(error if error is not None else future.result())
    return outcomes


def test_identical_fills_coalesce_whatever_the_order_of_the_points() -> None:
    provider = GatedProvider()
    requests = [[DENVER, SLC], [SLC, DENVER], [DENVER, SLC], [SLC, DENVER]]

    outcomes = _race(make(provider), provider, requests)

    assert len(provider.calls) == 1
    assert all(isinstance(outcome, dict) and set(outcome) == {DENVER, SLC} for outcome in outcomes)
    assert WeatherCache.objects.count() == 2


def test_waiters_share_the_failure_of_the_fill_they_waited_for() -> None:
    provider = GatedProvider(failure=ProviderUnavailableError("open-meteo", "HTTP 500"))

    outcomes = _race(make(provider), provider, [[DENVER], [DENVER], [DENVER]])

    # One attempt, not one per waiter after the other (R2-10).
    assert len(provider.calls) == 1
    assert all(isinstance(o, ProblemError) and o.code == "weather_unavailable" for o in outcomes)


def test_when_the_wait_runs_out_the_fill_still_happens_unprotected(
    caplog: pytest.LogCaptureFixture,
) -> None:
    provider = GatedProvider(gated=1)  # only the first fetch waits; the unprotected one passes
    service = make(provider)

    with ThreadPoolExecutor(max_workers=1) as pool:
        leader = pool.submit(hourly_in_thread, service, [DENVER], window())
        wait_for_fetches(provider, 1)
        with caplog.at_level(logging.WARNING, logger="haulcast.weather"), deadline_scope(0.5):
            result = service.hourly([DENVER], window())
        provider.release.set()
        leader.result(timeout=WAIT_S)

    assert result[DENVER].hours == 3
    assert len(provider.calls) == 2
    assert "weather_flight_timeout" in caplog.text
