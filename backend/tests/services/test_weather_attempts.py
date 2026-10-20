"""Open-Meteo is paid for per attempt and outside every lock, and a fill keeps what arrived.

R2-23: the shared budget used to be drawn once per fill, before the call. The retries Open-Meteo
counts were free (the guard under-counted real usage), and when the second chunk of a fill failed
the first chunk's forecasts, already paid for, were thrown away and bought again by the retry.

R2-01 (client level): the draw is its own short transaction and commits before the request is
sent, so a slow upstream holds no row lock and no connection while other requests draw.

These tests wire the real pieces (the Open-Meteo adapter, the retrying client, the attempt hook,
the PostgreSQL budget, the service) and replace only the network with a mock transport.
"""

import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import timedelta
from urllib.parse import parse_qs

import httpx
import pytest
from django.db import connection, connections

from haulcast.problems import ProblemError
from haulcast.providers.http import Pacing, UpstreamClient, build_client
from haulcast.providers.weather.base import VARIABLES, LatticePoint
from haulcast.providers.weather.openmeteo import OpenMeteoProvider
from haulcast.services.budget import OPEN_METEO, UpstreamBudgetGuard
from haulcast.services.weather import WeatherService
from haulcast.store.models import UpstreamBudget, WeatherCache
from tests.services.test_weather import CONFIG, DENVER, SLC, START, Clock, window

pytestmark = pytest.mark.django_db(transaction=True)

BOISE = LatticePoint(436, -1162)
HOURS = 3
MINUTE_KEY = f"{OPEN_METEO.name}:minute"
UNITS = {
    "time": "unixtime",
    "wind_speed_10m": "mp/h",
    "wind_gusts_10m": "mp/h",
    "rain": "inch",
    "showers": "inch",
    "snowfall": "inch",
    "precipitation": "inch",
    "temperature_2m": "\N{DEGREE SIGN}F",
    "weather_code": "wmo code",
}
Handler = Callable[[httpx.Request], httpx.Response]
Cells = list[tuple[str, str]]


def cells_of(request: httpx.Request) -> Cells:
    """The ``(lat, lon)`` strings of the locations a request asks for."""
    form = parse_qs(request.content.decode("ascii"))
    return list(zip(form["latitude"][0].split(","), form["longitude"][0].split(","), strict=True))


def location(lat: float, lon: float) -> dict[str, object]:
    """One valid Open-Meteo location entry for the window used in these tests."""
    stamps = [int((START + timedelta(hours=hour)).timestamp()) for hour in range(HOURS)]
    hourly: dict[str, object] = {"time": stamps}
    for name in VARIABLES:
        hourly[name] = [3] * HOURS if name == "weather_code" else [1.0] * HOURS
    return {
        "latitude": lat,
        "longitude": lon,
        "elevation": 1_600.0,
        "hourly_units": UNITS,
        "hourly": hourly,
    }


def echoing(asked: list[Cells]) -> Handler:
    """Answer every request like Open-Meteo would, and record which cells were asked for."""

    def handler(request: httpx.Request) -> httpx.Response:
        cells = cells_of(request)
        asked.append(cells)
        items = [location(float(lat), float(lon)) for lat, lon in cells]
        return httpx.Response(200, json=items[0] if len(items) == 1 else items)

    return handler


def service_over(handler: Handler, *, chunk_size: int = 250) -> WeatherService:
    """The production wiring of the weather path, with a mock transport instead of the network."""
    upstream = UpstreamClient(
        OpenMeteoProvider.name,
        client=build_client(transport=httpx.MockTransport(handler)),
        pacing=Pacing(sleep=lambda _seconds: None, jitter=lambda: 0.0),
        before_attempt=UpstreamBudgetGuard().attempt_hook(OPEN_METEO, OpenMeteoProvider.name),
    )
    return WeatherService(OpenMeteoProvider(upstream, chunk_size=chunk_size), CONFIG, clock=Clock())


@contextmanager
def charges() -> Iterator[list[tuple[str, int]]]:
    """Record ``(budget window key, cost)`` of every draw made inside the block."""
    seen: list[tuple[str, int]] = []

    def record(execute: Callable[..., object], statement: str, *rest: object) -> object:
        if "upstream_budget_take" in statement:
            params = rest[0]
            assert isinstance(params, list)
            seen.append((str(params[0]), int(params[4])))
        return execute(statement, *rest)

    with connection.execute_wrapper(record):
        yield seen


def minute_costs(seen: list[tuple[str, int]]) -> list[int]:
    return [cost for key, cost in seen if key == MINUTE_KEY]


# --------------------------------------------------------------------------- paid per attempt


def test_every_attempt_is_paid_for_before_it_is_sent_retries_included() -> None:
    answers = iter([503, 503, 200])
    answer = echoing([])

    def handler(request: httpx.Request) -> httpx.Response:
        status = next(answers)
        return httpx.Response(status) if status != 200 else answer(request)

    with charges() as seen:
        result = service_over(handler).hourly([DENVER, SLC], window(HOURS))

    assert set(result) == {DENVER, SLC}
    assert minute_costs(seen) == [2, 2, 2], "three attempts of two locations each"


def test_tokens_spent_on_a_fill_that_then_fails_stay_spent() -> None:
    # The upstream may already have counted an attempt that failed, so nothing is given back.
    service = service_over(lambda _request: httpx.Response(503))

    with charges() as seen, pytest.raises(ProblemError) as raised:
        service.hourly([DENVER], window(HOURS))

    assert raised.value.code == "weather_unavailable"
    assert minute_costs(seen) == [1, 1, 1]
    assert UpstreamBudget.objects.filter(key__startswith=f"{OPEN_METEO.name}:").count() == 3
    assert WeatherCache.objects.count() == 0


def test_a_request_the_guard_refuses_is_never_sent() -> None:
    asked: list[Cells] = []
    points = [LatticePoint(300 + index // 40, -1000 - index % 40) for index in range(300)]
    service = service_over(echoing(asked))

    with pytest.raises(ProblemError) as raised:
        service.hourly(points, window(HOURS))

    error = raised.value
    assert (error.code, error.status) == ("weather_capacity_exhausted", 503)
    assert error.retry_after_s is not None
    assert error.retry_after_s > 0
    assert [len(cells) for cells in asked] == [250], "the 250 first locations used the whole burst"


# --------------------------------------------------------------------------- what arrived is kept


def test_the_chunk_that_arrived_is_kept_when_the_next_one_is_refused() -> None:
    points = [LatticePoint(300 + index // 40, -1000 - index % 40) for index in range(300)]
    service = service_over(echoing([]))

    with pytest.raises(ProblemError):
        service.hourly(points, window(HOURS))

    assert WeatherCache.objects.count() == 250
    answered = service_over(lambda _request: pytest.fail("a stored forecast needed the upstream"))
    assert set(answered.hourly(points[:250], window(HOURS))) == set(points[:250])


def test_a_failed_second_chunk_keeps_the_first_and_the_retry_pays_only_for_the_rest() -> None:
    asked: list[Cells] = []
    answer = echoing(asked)
    refuse = [True]

    def handler(request: httpx.Request) -> httpx.Response:
        if refuse[0] and len(cells_of(request)) == 1:
            return httpx.Response(400, json={"error": True, "reason": "refused"})
        return answer(request)

    service = service_over(handler, chunk_size=2)
    with pytest.raises(ProblemError) as raised:
        service.hourly([DENVER, SLC, BOISE], window(HOURS))
    assert (raised.value.code, raised.value.status) == ("weather_unavailable", 502)
    assert {row.location_key for row in WeatherCache.objects.all()} == {DENVER.key, SLC.key}

    refuse[0] = False
    asked.clear()
    with charges() as seen:
        result = service.hourly([DENVER, SLC, BOISE], window(HOURS))

    assert set(result) == {DENVER, SLC, BOISE}
    assert [len(cells) for cells in asked] == [1], "only the failed chunk is asked for again"
    assert minute_costs(seen) == [1]


# --------------------------------------------------------------------------- nothing is held


def test_no_transaction_and_no_row_lock_is_held_while_a_request_is_in_flight() -> None:
    outcome: dict[str, object] = {}
    answer = echoing([])

    def draw() -> None:
        try:
            UpstreamBudgetGuard().take(OPEN_METEO, 1)
        finally:
            connections.close_all()

    def handler(request: httpx.Request) -> httpx.Response:
        outcome["in_transaction"] = connection.in_atomic_block
        other = threading.Thread(target=draw)
        other.start()
        other.join(timeout=10)  # the budget's row locks used to be held until the fill ended
        outcome["draw_still_waiting"] = other.is_alive()
        return answer(request)

    service_over(handler).hourly([DENVER], window(HOURS))

    assert outcome == {"in_transaction": False, "draw_still_waiting": False}
