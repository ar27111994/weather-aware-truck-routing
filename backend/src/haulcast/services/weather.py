"""Weather use case: hourly forecasts for lattice points, through cache, budget guard and provider.

``WeatherService.hourly`` is the only way the application obtains real forecasts. For a set of
0.1 degree lattice points and one hour window it

1. answers from the per-instance LRU, then from the ``weather_cache`` table (60 minutes);
2. for what is still missing takes a *coarse* advisory lock per (model, variable set, window start),
   so concurrent plans departing in the same hour share one fill instead of racing; after getting
   the lock it re-reads the table (a concurrent plan may have filled it);
3. draws the number of still-missing locations from the shared Open-Meteo budget (minute/hour/day
   windows in PostgreSQL) *before* contacting the upstream, so a spike ends in a clean
   ``weather_capacity_exhausted`` problem (503 + ``Retry-After``) rather than an upstream ban;
4. fetches them in one batched provider call and stores them.

Everything cached keeps serving while the budget is exhausted. A forecast stored for a longer window
than requested satisfies the shorter request (it is trimmed). Budget tokens taken inside a fill that
then fails are refunded with the rolled-back transaction: an upstream that never answered cost us
nothing.
"""

import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Final

from haulcast.observability import record_cache_outcome
from haulcast.problems import ProblemError
from haulcast.providers.errors import (
    ProviderRateLimitedError,
    ProviderRejectedError,
    ProviderResponseError,
    ProviderUnavailableError,
)
from haulcast.providers.weather.base import (
    ForecastPayloadError,
    HourlyForecast,
    HourWindow,
    LatticePoint,
    WeatherProvider,
)
from haulcast.services.budget import OPEN_METEO, BudgetExhaustedError, UpstreamBudgetGuard
from haulcast.services.cache import TtlLruCache, utc_now
from haulcast.services.locks import LockUnavailableError, advisory_lock
from haulcast.store.models import WeatherCache

logger = logging.getLogger("haulcast.weather")

WEATHER_TTL: Final = timedelta(minutes=60)
CAPACITY_DETAIL: Final = (
    "The forecast service is at capacity; try a simulated scenario or retry shortly."
)
DEFAULT_RETRY_AFTER_S: Final = 60.0
"""Open-Meteo's minutely limit resets within a minute; used when it sends no ``Retry-After``."""
_LRU_ENTRIES: Final = 2_048


@dataclass(frozen=True, slots=True)
class WeatherServiceConfig:
    """Cache identity and lifetime: ``variables_hash`` ties entries to the variable set."""

    variables_hash: str
    ttl: timedelta = WEATHER_TTL


def _truncate(forecast: HourlyForecast, hours: int) -> HourlyForecast:
    """Return ``forecast`` cut to its first ``hours`` samples (itself if already that long)."""
    if forecast.hours == hours:
        return forecast
    return replace(
        forecast,
        wind_speed_mph=forecast.wind_speed_mph[:hours],
        wind_gust_mph=forecast.wind_gust_mph[:hours],
        rain_in=forecast.rain_in[:hours],
        showers_in=forecast.showers_in[:hours],
        snowfall_in=forecast.snowfall_in[:hours],
        precipitation_in=forecast.precipitation_in[:hours],
        temperature_f=forecast.temperature_f[:hours],
        weather_code=forecast.weather_code[:hours],
    )


class WeatherService:
    """Cached, budget-guarded access to hourly forecasts."""

    def __init__(
        self,
        provider: WeatherProvider,
        config: WeatherServiceConfig,
        *,
        budget: UpstreamBudgetGuard,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        """Wire the ``provider`` to its cache ``config``, the shared ``budget`` and a clock."""
        self._provider = provider
        self._config = config
        self._budget = budget
        self._clock = clock
        self._lru = TtlLruCache[HourlyForecast](_LRU_ENTRIES)

    def hourly(
        self, points: Sequence[LatticePoint], window: HourWindow
    ) -> dict[LatticePoint, HourlyForecast]:
        """Return one forecast per distinct point of ``points``, each covering exactly ``window``.

        Raises:
            ProblemError: ``weather_capacity_exhausted`` (503, with ``Retry-After``) when the shared
                budget or the upstream's own limit refuses, ``weather_unavailable`` (503/502)
                when the upstream failed.
        """
        unique = list(dict.fromkeys(points))
        found: dict[LatticePoint, HourlyForecast] = {}
        for point in unique:
            cached = self._lru.get(self._lru_key(point, window))
            if cached is not None:
                found[point] = cached
        missing = [point for point in unique if point not in found]
        if missing:
            found.update(self._read_table(missing, window))
            missing = [point for point in unique if point not in found]
        record_cache_outcome("miss" if missing else "hit")
        if missing:
            found.update(self._fill(missing, window))
        return {point: found[point] for point in unique}

    def _fill(
        self, missing: Sequence[LatticePoint], window: HourWindow
    ) -> Mapping[LatticePoint, HourlyForecast]:
        """Fetch what the cache lacks, under the coarse lock when it can be had."""
        identity = f"{self._provider.model}:{self._config.variables_hash}"
        lock_name = f"weather:{identity}:{window.start.isoformat()}"
        try:
            with advisory_lock(lock_name):
                filled = dict(self._read_table(missing, window))
                todo = [point for point in missing if point not in filled]
                if todo:
                    filled.update(self._fetch_and_store(todo, window))
                return filled
        except LockUnavailableError:
            logger.warning("weather_lock_unavailable", extra={"event": "weather_unlocked_fill"})
            return self._fetch_and_store(missing, window)

    def _fetch_and_store(
        self, points: Sequence[LatticePoint], window: HourWindow
    ) -> dict[LatticePoint, HourlyForecast]:
        """Take budget, call the provider once for ``points`` and persist the answers."""
        try:
            self._budget.take(OPEN_METEO, len(points))
        except BudgetExhaustedError as exc:
            raise ProblemError(
                "weather_capacity_exhausted",
                detail=CAPACITY_DETAIL,
                retry_after_s=exc.retry_after_s,
            ) from exc
        try:
            fetched = dict(self._provider.fetch(points, window))
        except ProviderRateLimitedError as exc:
            raise ProblemError(
                "weather_capacity_exhausted",
                detail=CAPACITY_DETAIL,
                retry_after_s=exc.retry_after_s or DEFAULT_RETRY_AFTER_S,
            ) from exc
        except ProviderUnavailableError as exc:
            raise ProblemError(
                "weather_unavailable",
                detail="The forecast service is temporarily unavailable.",
                retry_after_s=exc.retry_after_s,
            ) from exc
        except (ProviderRejectedError, ProviderResponseError) as exc:
            raise ProblemError(
                "weather_unavailable",
                detail="The forecast service returned an unusable answer.",
                status=502,
            ) from exc
        self._store(list(fetched.values()), window)
        return {point: _truncate(forecast, window.hours) for point, forecast in fetched.items()}

    def _store(self, forecasts: Sequence[HourlyForecast], window: HourWindow) -> None:
        now = self._clock()
        rows = [
            WeatherCache(
                location_key=forecast.point.key,
                model=forecast.model,
                variables_hash=self._config.variables_hash,
                window_start=window.start,
                hours=window.hours,
                payload=forecast.to_payload(),
                fetched_at=now,
                expires_at=now + self._config.ttl,
            )
            for forecast in forecasts
        ]
        WeatherCache.objects.bulk_create(
            rows,
            update_conflicts=True,
            unique_fields=["location_key", "model", "variables_hash", "window_start"],
            update_fields=["hours", "payload", "fetched_at", "expires_at"],
        )
        for forecast in forecasts:
            self._lru.put(
                self._lru_key(forecast.point, window),
                _truncate(forecast, window.hours),
                self._config.ttl.total_seconds(),
            )

    def _read_table(
        self, points: Sequence[LatticePoint], window: HourWindow
    ) -> dict[LatticePoint, HourlyForecast]:
        """Return the unexpired stored forecasts that cover ``window`` for ``points``."""
        by_key = {point.key: point for point in points}
        rows = WeatherCache.objects.filter(
            location_key__in=list(by_key),
            model=self._provider.model,
            variables_hash=self._config.variables_hash,
            window_start=window.start,
            hours__gte=window.hours,
            expires_at__gt=self._clock(),
        ).values_list("location_key", "payload")
        found: dict[LatticePoint, HourlyForecast] = {}
        for location_key, payload in rows:
            point = by_key[location_key]
            try:
                forecast = HourlyForecast.from_payload(point, self._provider.model, payload)
            except ForecastPayloadError:
                logger.warning(
                    "weather_payload_undecodable", extra={"event": "cache_decode_failed"}
                )
                continue
            found[point] = _truncate(forecast, window.hours)
            self._lru.put(
                self._lru_key(point, window), found[point], self._config.ttl.total_seconds()
            )
        return found

    @staticmethod
    def _lru_key(point: LatticePoint, window: HourWindow) -> str:
        return f"{point.key}|{window.start.isoformat()}|{window.hours}"
