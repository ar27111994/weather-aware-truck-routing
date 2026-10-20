"""Fakes for service-level tests: scripted providers, a fixed clock, synthetic routes.

The recorded-provider flows live in ``test_create_plan``; failures, caps and budgets are provoked
here with providers that raise on demand, because a failure that has to be waited for (retry
backoff, a 25 second budget) would make the suite slow without making it truer.
"""

import itertools
import math
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from haulcast.domain import RiskRules
from haulcast.providers.routing.base import Coordinate, RouteOption, RoutingProvider, RoutingResult
from haulcast.providers.weather.base import (
    HourlyForecast,
    HourWindow,
    LatticePoint,
    WeatherProvider,
)
from haulcast.services.budget import UpstreamBudgetGuard
from haulcast.services.container import risk_rules, scenario_catalog
from haulcast.services.heatmap_service import HeatmapService
from haulcast.services.plan_request import Place, PlanRequest
from haulcast.services.plan_service import PlanService
from haulcast.services.plan_store import Runtime
from haulcast.services.routing import RoutingService, route_cache
from haulcast.services.weather import WeatherService, WeatherServiceConfig

FIXED_NOW = datetime(2026, 10, 20, 13, 40, tzinfo=UTC)
DEPARTURE = datetime(2026, 10, 20, 14, 0, tzinfo=UTC)
MILES_PER_DEGREE = 69.093
SLC = (-111.891, 40.7608)


class Clock:
    """A settable wall clock."""

    def __init__(self, now: datetime = FIXED_NOW) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


class Ticker:
    """A settable monotonic clock for the request budget."""

    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


def runtime(clock: Clock | None = None, ticker: Ticker | None = None) -> Runtime:
    """A runtime with a controllable clock and ids that are valid plan ids, in order."""
    counter = itertools.count(1)
    return Runtime(
        clock=clock or Clock(),
        new_id=lambda _created: f"pln_{next(counter):026d}",
        monotonic=ticker or Ticker(),
    )


def straight_route(
    miles: float, *, points: int = 120, speed_mph: float = 55.0, lat_shift: float = 0.0
) -> RouteOption:
    """A due-east route of ``miles`` from Salt Lake City's longitude, at a constant speed.

    ``lat_shift`` moves the whole route north (degrees), so that routes made with different
    shifts share no weather lattice point.
    """
    lat = SLC[1] + lat_shift
    degrees = miles / (MILES_PER_DEGREE * math.cos(math.radians(lat)))
    coords: tuple[Coordinate, ...] = tuple(
        (SLC[0] + degrees * index / (points - 1), lat) for index in range(points)
    )
    duration_s = miles / speed_mph * 3600
    cum_s = tuple(duration_s * index / (points - 1) for index in range(points))
    return RouteOption(coords, cum_s, miles, duration_s, "via I-80")


def result_of(*routes: RouteOption, provider: str = "valhalla") -> RoutingResult:
    """A routing result as a provider would answer."""
    return RoutingResult(provider=provider, routes=tuple(routes))


class ScriptedRouting:
    """A routing provider that answers (or raises) as told and counts its calls."""

    name = "scripted"

    def __init__(self, outcome: RoutingResult | Exception, *, delay_s: float = 0.0) -> None:
        self.outcome = outcome
        self.delay_s = delay_s
        self.calls: list[tuple[Coordinate, Coordinate, int]] = []
        self.on_call: list[object] = []

    def route(
        self, origin: Coordinate, destination: Coordinate, *, load_weight_lb: int
    ) -> RoutingResult:
        self.calls.append((origin, destination, load_weight_lb))
        if self.delay_s:
            time.sleep(self.delay_s)
        for hook in self.on_call:
            if callable(hook):
                hook()
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


@dataclass
class ScriptedWeather:
    """A weather provider with calm, constant weather that counts calls and can fail."""

    wind_mph: float = 6.0
    failure: Exception | None = None
    delay_s: float = 0.0
    name: str = "open-meteo"
    model: str = "best_match"
    fetches: list[tuple[int, HourWindow]] = field(default_factory=list)

    def fetch(
        self, points: Sequence[LatticePoint], window: HourWindow
    ) -> dict[LatticePoint, HourlyForecast]:
        self.fetches.append((len(points), window))
        if self.delay_s:
            time.sleep(self.delay_s)
        if self.failure is not None:
            raise self.failure
        hours = window.hours
        return {
            point: HourlyForecast(
                point=point,
                model=self.model,
                start=window.start,
                wind_speed_mph=(self.wind_mph,) * hours,
                wind_gust_mph=(self.wind_mph + 3,) * hours,
                rain_in=(0.0,) * hours,
                showers_in=(0.0,) * hours,
                snowfall_in=(0.0,) * hours,
                precipitation_in=(0.0,) * hours,
                temperature_f=(60.0,) * hours,
                weather_code=(1,) * hours,
            )
            for point in points
        }


@dataclass
class Services:
    """Plan and heatmap services over scripted providers, plus the scripts for assertions."""

    plans: PlanService
    heatmaps: HeatmapService
    routing: ScriptedRouting
    weather: ScriptedWeather


def build_services(
    routing: ScriptedRouting,
    weather: ScriptedWeather | None = None,
    rt: Runtime | None = None,
    rules: RiskRules | None = None,
) -> Services:
    """Wire real services (real caches, real budget, real Postgres) over scripted providers."""
    rt = rt or runtime()
    weather = weather or ScriptedWeather()
    rules = rules or risk_rules()
    routing_provider: RoutingProvider = routing
    weather_provider: WeatherProvider = weather
    weather_service = WeatherService(
        weather_provider,
        WeatherServiceConfig(variables_hash="scripted"),
        budget=UpstreamBudgetGuard(),
        clock=rt.clock,
    )
    return Services(
        plans=PlanService(
            RoutingService(routing_provider, route_cache(clock=rt.clock)),
            weather_service,
            scenario_catalog(),
            rules,
            rt,
        ),
        heatmaps=HeatmapService(weather_service, scenario_catalog(), rules, rt),
        routing=routing,
        weather=weather,
    )


def request_for(
    *,
    miles_apart: float | None = None,
    departure: datetime = DEPARTURE,
    load: int = 38_000,
    interval: int = 25,
    scenario: str | None = None,
) -> PlanRequest:
    """A request from Salt Lake City to Denver, or to a point ``miles_apart`` due north."""
    if miles_apart is None:
        destination = Place(39.7392, -104.9903, "Denver, Colorado")
    else:
        destination = Place(SLC[1] + miles_apart / MILES_PER_DEGREE, SLC[0], "Destination")
    return PlanRequest(
        origin=Place(SLC[1], SLC[0], "Salt Lake City, Utah"),
        destination=destination,
        departure=departure,
        load_weight_lb=load,
        sampling_interval_mi=interval,
        scenario=scenario,
    )


def minutes(count: float) -> timedelta:
    """A ``timedelta`` of ``count`` minutes."""
    return timedelta(minutes=count)
