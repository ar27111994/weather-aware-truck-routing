"""The weather use case: LRU, table cache, shared budget, single fill per window, error mapping."""

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
)
from haulcast.providers.weather.base import HourlyForecast, HourWindow, LatticePoint
from haulcast.services.budget import OPEN_METEO, Budget, BudgetExhaustedError, UpstreamBudgetGuard
from haulcast.services.weather import (
    DEFAULT_RETRY_AFTER_S,
    WEATHER_TTL,
    WeatherService,
    WeatherServiceConfig,
)
from haulcast.store.models import UpstreamBudget, WeatherCache

START = datetime(2026, 10, 20, 14, 0, tzinfo=UTC)
NOW = datetime(2026, 10, 20, 13, 40, tzinfo=UTC)
DENVER = LatticePoint(397, -1050)
SLC = LatticePoint(408, -1119)
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

    def __init__(self, model: str = "best_match", failure: Exception | None = None) -> None:
        self.model = model
        self.failure = failure
        self.calls: list[tuple[tuple[LatticePoint, ...], HourWindow]] = []
        self.extra_hours = 0

    def fetch(
        self, points: Sequence[LatticePoint], window: HourWindow
    ) -> Mapping[LatticePoint, HourlyForecast]:
        self.calls.append((tuple(points), window))
        if self.failure is not None:
            raise self.failure
        return {
            point: forecast(point, window.hours + self.extra_hours, window.start, self.model)
            for point in points
        }


class RecordingBudget(UpstreamBudgetGuard):
    """Records the cost of every take; optionally refuses."""

    def __init__(self, refusal: BudgetExhaustedError | None = None) -> None:
        self.refusal = refusal
        self.takes: list[tuple[str, int]] = []

    @property
    def costs(self) -> list[int]:
        """The cost of every take, in order."""
        return [cost for _, cost in self.takes]

    def take(self, budget: Budget, cost: int) -> None:
        self.takes.append((budget.name, cost))
        if self.refusal is not None:
            raise self.refusal


def make(
    provider: FakeProvider | None = None,
    budget: UpstreamBudgetGuard | None = None,
    clock: Clock | None = None,
) -> tuple[WeatherService, FakeProvider]:
    chosen = provider or FakeProvider()
    service = WeatherService(
        chosen, CONFIG, budget=budget or RecordingBudget(), clock=clock or Clock()
    )
    return service, chosen


def window(hours: int = 3, start: datetime = START) -> HourWindow:
    return HourWindow(start, hours)


# --------------------------------------------------------------------------- the happy path


def test_a_cold_request_fetches_once_for_every_distinct_point_and_stores_the_rows() -> None:
    budget = RecordingBudget()
    service, provider = make(budget=budget)

    result = service.hourly([DENVER, SLC, DENVER], window())

    assert list(result) == [DENVER, SLC]
    assert result[DENVER].wind_speed_mph == (397.0, 398.0, 399.0)
    assert result[SLC].wind_speed_mph == (408.0, 409.0, 410.0)
    assert provider.calls == [((DENVER, SLC), window())]
    assert budget.costs == [2]
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


def test_only_the_missing_points_are_fetched_and_paid_for() -> None:
    first, _ = make()
    first.hourly([DENVER], window())
    budget = RecordingBudget()
    second, provider = make(budget=budget)
    tokens = begin_request_metrics()

    result = second.hourly([DENVER, SLC], window())

    assert set(result) == {DENVER, SLC}
    assert provider.calls == [((SLC,), window())]
    assert budget.costs == [1]
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


# --------------------------------------------------------------------------- budget and failures


def test_an_exhausted_budget_is_a_503_with_the_refill_time_and_the_upstream_is_not_called() -> None:
    budget = RecordingBudget(BudgetExhaustedError("openmeteo", 12.5))
    service, provider = make(budget=budget)

    with pytest.raises(ProblemError) as raised:
        service.hourly([DENVER], window())

    error = raised.value
    assert (error.code, error.status, error.retry_after_s) == (
        "weather_capacity_exhausted",
        503,
        12.5,
    )
    assert provider.calls == []
    assert WeatherCache.objects.count() == 0


def test_cached_forecasts_keep_being_served_while_the_budget_is_exhausted() -> None:
    warm, _ = make()
    warm.hourly([DENVER], window())
    exhausted = RecordingBudget(BudgetExhaustedError("openmeteo", 30.0))
    cold, provider = make(budget=exhausted)

    assert cold.hourly([DENVER], window())[DENVER].hours == 3
    assert exhausted.costs == []
    assert provider.calls == []


def test_the_real_budget_is_drawn_from_before_the_upstream_is_called() -> None:
    service = WeatherService(FakeProvider(), CONFIG, budget=UpstreamBudgetGuard(), clock=Clock())

    service.hourly([DENVER, SLC], window())

    charged = UpstreamBudget.objects.filter(key__startswith=f"{OPEN_METEO.name}:")
    assert charged.count() == len(OPEN_METEO.windows)


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


def test_budget_taken_by_a_fill_that_then_fails_stays_charged() -> None:
    # The upstream may already have counted the attempt, so nothing is given back: a refund that
    # rolled the draw back let the local guard under-count real usage (R2-23).
    provider = FakeProvider(failure=ProviderUnavailableError("open-meteo", "HTTP 500"))
    service = WeatherService(provider, CONFIG, budget=UpstreamBudgetGuard(), clock=Clock())

    with pytest.raises(ProblemError):
        service.hourly([DENVER], window())

    charged = UpstreamBudget.objects.filter(key__startswith=f"{OPEN_METEO.name}:")
    assert charged.count() == len(OPEN_METEO.windows)
    assert WeatherCache.objects.count() == 0


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
