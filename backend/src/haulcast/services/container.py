"""Process-wide wiring: the production collaborators of the API, built once and cached.

Endpoints depend on these accessor functions, never on provider classes, so tests swap a
collaborator by clearing the accessor's cache (``accessor.cache_clear()``) and mocking the HTTP
layer. Every accessor builds from constants and settings only: no request-controlled value ever
reaches a URL (SSRF-proof by construction), and building one never touches the network.

``HAULCAST_PROVIDER_MODE=replay`` changes three things, here and nowhere else: the HTTP clients are
built on the replay transport (recorded answers, no network), the pacing gate and the shared budget
are skipped (there is no server to be polite to), and the wall clock is frozen at
``HAULCAST_REPLAY_NOW``. Monotonic clocks stay live: the rate limiter, the request deadlines and
the retry pacing run on real time in both modes. Live mode is unchanged.
"""

from collections.abc import Callable
from datetime import datetime
from functools import cache

import httpx
from django.conf import settings

from haulcast.config.env import REPLAY_NOW_VARIABLE, ConfigError, ProviderMode
from haulcast.config.paths import shared_dir
from haulcast.config.timeouts import GEOCODE_ATTEMPT_S
from haulcast.domain import RiskRules, load_rules_file
from haulcast.providers.geocoding.chain import GeocodingChain
from haulcast.providers.geocoding.openmeteo import OpenMeteoGeocodingProvider
from haulcast.providers.geocoding.photon import PhotonProvider
from haulcast.providers.health import ProviderHealth
from haulcast.providers.http import HttpPolicy, UpstreamClient, build_client
from haulcast.providers.replay.clock import frozen_clock
from haulcast.providers.replay.transport import build_replay_transport
from haulcast.providers.routing import osrm, valhalla
from haulcast.providers.routing.chain import RoutingChain
from haulcast.providers.routing.osrm import OsrmProvider
from haulcast.providers.routing.throttle import MinIntervalGate
from haulcast.providers.routing.valhalla import ValhallaProvider
from haulcast.providers.weather.openmeteo import VARIABLE_SET_HASH, OpenMeteoProvider
from haulcast.providers.weather.scenarios import ScenarioCatalog
from haulcast.services.budget import OPEN_METEO, ROUTING, UpstreamBudgetGuard
from haulcast.services.cache import utc_now
from haulcast.services.geocoding import GeocodingService, geocode_cache
from haulcast.services.heatmap_service import HeatmapService
from haulcast.services.plan_service import PlanService
from haulcast.services.plan_store import Runtime
from haulcast.services.routing import RoutingService, route_cache
from haulcast.services.rules import RULES_FILENAME, RulesDocument, load_rules_document
from haulcast.services.weather import WeatherService, WeatherServiceConfig

ROUTING_MIN_INTERVAL_S = 1.0
"""Decision D-19: calls to one routing server are strictly sequential, at least a second apart."""

GEOCODING_HTTP_POLICY = HttpPolicy(
    max_retries=0, rate_limit_retries=0, attempt_deadline_s=GEOCODE_ATTEMPT_S
)
"""One bounded attempt per geocoding provider: the other provider is the retry (T14)."""

ROUTING_HTTP_POLICY = HttpPolicy(max_retries=1)
"""One retry only: each retry spends a call of the shared routing budget and a second of spacing."""


def replaying() -> bool:
    """Whether provider answers come from the replay catalog (``HAULCAST_PROVIDER_MODE=replay``)."""
    return settings.HAULCAST_PROVIDER_MODE is ProviderMode.REPLAY


def _transport() -> httpx.BaseTransport | None:
    """The transport that serves recorded answers in replay mode; ``None`` (the network) in live."""
    return build_replay_transport(settings.HAULCAST_REPLAY_DIR) if replaying() else None


def wall_clock() -> Callable[[], datetime]:
    """The wall clock of the wiring: real time, or the instant replay mode freezes it at.

    Raises:
        ConfigError: replay mode without ``HAULCAST_REPLAY_NOW`` (``Config`` already refuses to
            start like that; this guards settings assembled by hand).
    """
    if not replaying():
        return utc_now
    now = settings.HAULCAST_REPLAY_NOW
    if now is None:
        raise ConfigError(f"{REPLAY_NOW_VARIABLE} is required in replay mode")
    return frozen_clock(now)


def runtime() -> Runtime:
    """The clock and id source of the use cases: live, but for the wall clock in replay mode."""
    return Runtime(clock=wall_clock())


@cache
def rules_document() -> RulesDocument:
    """The ``shared/risk-rules.json`` document and its ETag (read once per process)."""
    return load_rules_document()


@cache
def scenario_catalog() -> ScenarioCatalog:
    """The demo weather scenarios of ``shared/scenarios`` (validated once per process)."""
    return ScenarioCatalog.load()


@cache
def geocoding_service() -> GeocodingService:
    """Open-Meteo's city index first, Photon second, behind the cache and a 3.5 s budget.

    The order follows T14's measurements (Photon 6.7 s for an uncached query from iad1,
    Open-Meteo 1.0 to 1.4 s): the provider that can answer inside the budget goes first. Photon
    knows addresses and places Open-Meteo does not, so it is asked when Open-Meteo has nothing or
    fails. Each provider gets one attempt of at most 2 s. Swap the two arguments (and the
    budget in ``config.timeouts``) if Photon's latency from the deployment region improves.
    """
    transport = _transport()
    primary = OpenMeteoGeocodingProvider(
        UpstreamClient(
            OpenMeteoGeocodingProvider.name,
            client=build_client(transport=transport),
            policy=GEOCODING_HTTP_POLICY,
        )
    )
    fallback = PhotonProvider(
        UpstreamClient(
            PhotonProvider.name,
            client=build_client(transport=transport),
            policy=GEOCODING_HTTP_POLICY,
        )
    )
    chain = GeocodingChain(primary, fallback, health=ProviderHealth())
    return GeocodingService(chain, geocode_cache(wall_clock()))


@cache
def routing_chain() -> RoutingChain:
    """Valhalla for trucks (and trips within its range), OSRM for long hauls and as fallback.

    Every attempt of either client, a retry included, first keeps this process's minimum interval
    and then spends one call of the shared ``ROUTING`` budget (the only limit that holds between
    instances). Replay mode has no server to be polite to and no allowance to spend: it does
    neither.
    """
    top_speed_kph = settings.HAULCAST_TRUCK_TOP_SPEED_KPH
    transport = _transport()
    guard = UpstreamBudgetGuard()

    def before_attempt(provider: str) -> Callable[[int], None] | None:
        if replaying():
            return None
        pace = MinIntervalGate(ROUTING_MIN_INTERVAL_S, name=provider).wait
        return guard.attempt_hook(ROUTING, provider, pace=pace)

    truck = ValhallaProvider(
        UpstreamClient(
            valhalla.PROVIDER_NAME,
            client=build_client(headers=valhalla.client_headers(), transport=transport),
            policy=ROUTING_HTTP_POLICY,
            before_attempt=before_attempt(valhalla.PROVIDER_NAME),
        ),
        top_speed_kph=top_speed_kph,
    )
    car = OsrmProvider(
        UpstreamClient(
            osrm.PROVIDER_NAME,
            client=build_client(transport=transport),
            policy=ROUTING_HTTP_POLICY,
            before_attempt=before_attempt(osrm.PROVIDER_NAME),
        ),
        top_speed_kph=top_speed_kph,
    )
    return RoutingChain(truck, car, health=ProviderHealth())


@cache
def weather_service() -> WeatherService:
    """Open-Meteo forecasts behind the table cache and the shared upstream budget.

    The client spends the ``OPEN_METEO`` budget immediately before every attempt, retries included
    (the upstream counts each one), and a refusal ends the call without contacting it. Replay mode
    spends nothing: the forecasts are recorded.
    """
    client = UpstreamClient(
        OpenMeteoProvider.name,
        client=build_client(transport=_transport()),
        before_attempt=(
            None
            if replaying()
            else UpstreamBudgetGuard().attempt_hook(OPEN_METEO, OpenMeteoProvider.name)
        ),
    )
    return WeatherService(
        OpenMeteoProvider(client),
        WeatherServiceConfig(variables_hash=VARIABLE_SET_HASH),
        clock=wall_clock(),
    )


@cache
def risk_rules() -> RiskRules:
    """The validated risk rules of ``shared/risk-rules.json`` (read once per process)."""
    return load_rules_file(shared_dir() / RULES_FILENAME)


@cache
def routing_service() -> RoutingService:
    """The routing chain behind the 24-hour route cache."""
    return RoutingService(routing_chain(), route_cache(wall_clock()))


@cache
def plan_service() -> PlanService:
    """Plans: routing, weather and scenarios scored with the shared rules."""
    return PlanService(
        routing_service(), weather_service(), scenario_catalog(), risk_rules(), runtime()
    )


@cache
def heatmap_service() -> HeatmapService:
    """Heatmaps of stored plans, computed from the same weather source and rules."""
    return HeatmapService(weather_service(), scenario_catalog(), risk_rules(), runtime())
