"""The weather use case: LRU, table cache, single fill per window, batches, error mapping."""

import logging
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta

import pytest

from haulcast.observability import begin_request_metrics, end_request_metrics
from haulcast.problems import ProblemError
from haulcast.providers.errors import (
    ProviderRateLimitedError,
    ProviderRejectedError,
    ProviderResponseError,
    ProviderUnavailableError,
    UpstreamBudgetExhaustedError,
)
from haulcast.providers.weather.base import HourlyForecast, HourWindow, LatticePoint
from haulcast.services.weather import (
    DEFAULT_RETRY_AFTER_S,
    WEATHER_TTL,
    WeatherService,
    WeatherServiceConfig,
)
from haulcast.store.models import WeatherCache

START = datetime(2026, 10, 20, 14, 0, tzinfo=UTC)
NOW = datetime(2026, 10, 20, 13, 40, tzinfo=UTC)
DENVER = LatticePoint(397, -1050)
SLC = LatticePoint(408, -1119)
BOISE = LatticePoint(436, -1162)
CONFIG = WeatherServiceConfig(variables_hash="vars-test")

pytestmark = pytest.mark.django_db


class Clock:
    """A settable wall clock."""

    def __init__(self) -> None:
        self.now = NOW

    def __call__(self) -> datetime:
        return self.now


def forecast(
    point: LatticePoint, hours: int, start: datetime = START, model: str = "best_match"
) -> HourlyForecast:
    """A forecast whose first wind value identifies the point, so mix-ups are visible."""
    wind = tuple(float(point.lat_e1 + hour) for hour in range(hours))
    zeros = (0.0,) * hours
    return HourlyForecast(
        point=point,
        model=model,
        start=start,
        wind_speed_mph=wind,
        wind_gust_mph=wind,
        rain_in=zeros,
        showers_in=zeros,
        snowfall_in=zeros,
        precipitation_in=zeros,
        temperature_f=(40.0,) * hours,
        weather_code=(3,) * hours,
    )


class FakeProvider:
    """A weather provider that records its calls and can fail on demand."""

    name = "fake"

    def __init__(
        self,
        model: str = "best_match",
        failure: Exception | None = None,
        *,
        max_points: int = 250,
        fail_on_call: int | None = None,
    ) -> None:
        self.model = model
        self.failure = failure
        self.max_points = max_points
        self.fail_on_call = fail_on_call
        self.calls: list[tuple[tuple[LatticePoint, ...], HourWindow]] = []
        self.extra_hours = 0

    def fetch(
        self, points: Sequence[LatticePoint], window: HourWindow
    ) -> Mapping[LatticePoint, HourlyForecast]:
        self.calls.append((tuple(points), window))
        if self.failure is not None and self.fail_on_call in (None, len(self.calls)):
            raise self.failure
        return {
            point: forecast(point, window.hours + self.extra_hours, window.start, self.model)
            for point in points
        }


def make(
    provider: FakeProvider | None = None, clock: Clock | None = None
) -> tuple[WeatherService, FakeProvider]:
    chosen = provider or FakeProvider()
    return WeatherService(chosen, CONFIG, clock=clock or Clock()), chosen


def window(hours: int = 3, start: datetime = START) -> HourWindow:
    return HourWindow(start, hours)


# --------------------------------------------------------------------------- the happy path


def test_a_cold_request_fetches_once_for_every_distinct_point_and_stores_the_rows() -> None:
    service, provider = make()

    result = service.hourly([DENVER, SLC, DENVER], window())

    assert list(result) == [DENVER, SLC]
    assert result[DENVER].wind_speed_mph == (397.0, 398.0, 399.0)
    assert result[SLC].wind_speed_mph == (408.0, 409.0, 410.0)
    assert provider.calls == [((DENVER, SLC), window())]
    rows = {row.location_key: row for row in WeatherCache.objects.all()}
    assert set(rows) == {DENVER.key, SLC.key}
    assert rows[DENVER.key].expires_at == NOW + WEATHER_TTL
    assert (rows[DENVER.key].model, rows[DENVER.key].variables_hash) == ("best_match", "vars-test")
    assert (rows[DENVER.key].window_start, rows[DENVER.key].hours) == (START, 3)


def test_the_second_request_is_served_from_the_in_process_cache() -> None:
    service, provider = make()
    service.hourly([DENVER], window())
    tokens = begin_request_metrics()

    again = service.hourly([DENVER], window())

    assert again[DENVER].wind_speed_mph == (397.0, 398.0, 399.0)
    assert len(provider.calls) == 1
    assert end_request_metrics(tokens)[1] == ("hit",)


def test_a_cold_instance_is_served_from_the_table() -> None:
    first, _ = make()
    first.hourly([DENVER, SLC], window())
    second, provider = make()
    tokens = begin_request_metrics()

    result = second.hourly([DENVER, SLC], window())

    assert result[SLC].wind_speed_mph == (408.0, 409.0, 410.0)
    assert provider.calls == []
    assert end_request_metrics(tokens)[1] == ("hit",)


def test_only_the_missing_points_are_fetched() -> None:
    first, _ = make()
    first.hourly([DENVER], window())
    second, provider = make()
    tokens = begin_request_metrics()

    result = second.hourly([DENVER, SLC], window())

    assert set(result) == {DENVER, SLC}
    assert provider.calls == [((SLC,), window())]
    assert end_request_metrics(tokens)[1] == ("miss",)


def test_the_result_follows_the_order_of_the_request() -> None:
    service, _ = make()

    assert list(service.hourly([SLC, DENVER], window())) == [SLC, DENVER]


def test_an_empty_request_costs_nothing() -> None:
    service, provider = make()

    assert service.hourly([], window()) == {}
    assert provider.calls == []


# --------------------------------------------------------------------------- windows and expiry


def test_a_longer_stored_window_satisfies_a_shorter_request_trimmed() -> None:
    long_service, _ = make()
    long_service.hourly([DENVER], window(6))
    short_service, provider = make()

    result = short_service.hourly([DENVER], window(3))

    assert result[DENVER].hours == 3
    assert result[DENVER].wind_speed_mph == (397.0, 398.0, 399.0)
    assert provider.calls == []


def test_a_shorter_stored_window_does_not_satisfy_a_longer_request_and_is_replaced() -> None:
    short_service, _ = make()
    short_service.hourly([DENVER], window(3))
    long_service, provider = make()

    result = long_service.hourly([DENVER], window(6))

    assert result[DENVER].hours == 6
    assert provider.calls == [((DENVER,), window(6))]
    assert WeatherCache.objects.get().hours == 6


def test_a_forecast_older_than_an_hour_is_fetched_again() -> None:
    clock = Clock()
    service, provider = make(clock=clock)
    service.hourly([DENVER], window())
    clock.now = NOW + WEATHER_TTL
    fresh, _ = make(provider=provider, clock=clock)

    fresh.hourly([DENVER], window())

    assert len(provider.calls) == 2
    assert WeatherCache.objects.get().expires_at == clock.now + WEATHER_TTL


def test_the_in_process_cache_honours_the_ttl_too() -> None:
    clock = Clock()
    service, provider = make(clock=clock)
    service.hourly([DENVER], window())
    WeatherCache.objects.all().delete()  # only the in-process copy can answer now

    assert service.hourly([DENVER], window())[DENVER].hours == 3
    assert len(provider.calls) == 1


def test_a_different_window_start_is_a_different_entry() -> None:
    service, provider = make()
    service.hourly([DENVER], window(3, START))
    service.hourly([DENVER], window(3, START + timedelta(hours=1)))

    assert len(provider.calls) == 2
    assert WeatherCache.objects.count() == 2


def test_different_models_never_share_rows() -> None:
    first, _ = make(FakeProvider(model="best_match"))
    first.hourly([DENVER], window())
    other, provider = make(FakeProvider(model="gfs_seamless"))

    other.hourly([DENVER], window())

    assert len(provider.calls) == 1
    assert set(WeatherCache.objects.values_list("model", flat=True)) == {
        "best_match",
        "gfs_seamless",
    }


def test_a_provider_that_returns_more_hours_than_asked_is_trimmed() -> None:
    provider = FakeProvider()
    provider.extra_hours = 3
    service, _ = make(provider)

    result = service.hourly([DENVER], window(3))

    assert result[DENVER].hours == 3


# --------------------------------------------------------------------------- batches


def test_a_fill_is_split_into_batches_of_the_providers_size_in_request_order() -> None:
    service, provider = make(FakeProvider(max_points=2))

    result = service.hourly([DENVER, SLC, BOISE, DENVER], window())

    assert list(result) == [DENVER, SLC, BOISE]
    assert [points for points, _ in provider.calls] == [(DENVER, SLC), (BOISE,)]
    assert {row.location_key for row in WeatherCache.objects.all()} == {
        DENVER.key,
        SLC.key,
        BOISE.key,
    }


def test_the_batches_that_arrived_are_kept_when_a_later_one_fails() -> None:
    failure = ProviderUnavailableError("open-meteo", "HTTP 503")
    provider = FakeProvider(max_points=2, failure=failure, fail_on_call=2)
    service, _ = make(provider)

    with pytest.raises(ProblemError) as raised:
        service.hourly([DENVER, SLC, BOISE], window())

    assert raised.value.code == "weather_unavailable"
    assert {row.location_key for row in WeatherCache.objects.all()} == {DENVER.key, SLC.key}
    provider.failure = None
    result = service.hourly([DENVER, SLC, BOISE], window())
    assert set(result) == {DENVER, SLC, BOISE}
    assert provider.calls[-1][0] == (BOISE,), "only the batch that failed is fetched again"


# --------------------------------------------------------------------------- failures


def test_a_refused_attempt_is_a_503_with_the_refill_time() -> None:
    refusal = UpstreamBudgetExhaustedError(
        "open-meteo", "openmeteo budget exhausted", retry_after_s=12.5
    )
    service, _ = make(FakeProvider(failure=refusal))

    with pytest.raises(ProblemError) as raised:
        service.hourly([DENVER], window())

    error = raised.value
    assert (error.code, error.status, error.retry_after_s) == (
        "weather_capacity_exhausted",
        503,
        12.5,
    )
    assert WeatherCache.objects.count() == 0


def test_cached_forecasts_keep_being_served_while_the_budget_is_exhausted() -> None:
    warm, _ = make()
    warm.hourly([DENVER], window())
    refusal = UpstreamBudgetExhaustedError("open-meteo", "openmeteo budget exhausted")
    cold, provider = make(FakeProvider(failure=refusal))

    assert cold.hourly([DENVER], window())[DENVER].hours == 3
    assert provider.calls == []


@pytest.mark.parametrize(("hint", "expected"), [(30.0, 30.0), (None, DEFAULT_RETRY_AFTER_S)])
def test_an_upstream_429_is_capacity_exhausted_with_the_upstreams_or_the_default_wait(
    hint: float | None, expected: float
) -> None:
    provider = FakeProvider(
        failure=ProviderRateLimitedError("open-meteo", "429", retry_after_s=hint)
    )
    service, _ = make(provider)

    with pytest.raises(ProblemError) as raised:
        service.hourly([DENVER], window())

    assert raised.value.code == "weather_capacity_exhausted"
    assert raised.value.retry_after_s == expected


@pytest.mark.parametrize("hint", [7.0, None])
def test_an_unavailable_upstream_is_a_503_that_passes_on_the_hint(hint: float | None) -> None:
    provider = FakeProvider(
        failure=ProviderUnavailableError("open-meteo", "HTTP 503", retry_after_s=hint)
    )
    service, _ = make(provider)

    with pytest.raises(ProblemError) as raised:
        service.hourly([DENVER], window())

    error = raised.value
    assert (error.code, error.status, error.retry_after_s) == ("weather_unavailable", 503, hint)
    assert error.detail == "The forecast service is temporarily unavailable."


@pytest.mark.parametrize(
    "failure",
    [
        ProviderRejectedError("open-meteo", "HTTP 400", status=400),
        ProviderResponseError("open-meteo", "not json"),
    ],
    ids=["rejected", "garbled"],
)
def test_an_unusable_upstream_answer_is_a_502(failure: Exception) -> None:
    service, _ = make(FakeProvider(failure=failure))

    with pytest.raises(ProblemError) as raised:
        service.hourly([DENVER], window())

    error = raised.value
    assert (error.code, error.status) == ("weather_unavailable", 502)
    assert error.detail == "The forecast service returned an unusable answer."
    assert "400" not in (error.detail or "")


# --------------------------------------------------------------------------- damaged rows


def test_an_undecodable_stored_forecast_is_ignored_and_replaced(
    caplog: pytest.LogCaptureFixture,
) -> None:
    WeatherCache.objects.create(
        location_key=DENVER.key,
        model="best_match",
        variables_hash="vars-test",
        window_start=START,
        hours=3,
        payload={"v": 99, "garbage": True},
        expires_at=NOW + WEATHER_TTL,
    )
    service, provider = make()

    with caplog.at_level(logging.WARNING, logger="haulcast.weather"):
        result = service.hourly([DENVER], window())

    assert result[DENVER].wind_speed_mph == (397.0, 398.0, 399.0)
    assert len(provider.calls) == 1
    assert "weather_payload_undecodable" in caplog.text
    assert WeatherCache.objects.get().payload["v"] == 1
