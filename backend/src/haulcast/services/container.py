"""Process-wide wiring: the production collaborators of the API, built once and cached.

Endpoints depend on these accessor functions, never on provider classes, so tests swap a
collaborator by clearing the accessor's cache (``accessor.cache_clear()``) and mocking the HTTP
layer. Every accessor builds from constants and settings only: no request-controlled value ever
reaches a URL (SSRF-proof by construction), and building one never touches the network.
"""

from functools import cache

from django.conf import settings

from haulcast.config.paths import shared_dir
from haulcast.domain import RiskRules, load_rules_file
from haulcast.providers.geocoding.chain import GeocodingChain
from haulcast.providers.geocoding.openmeteo import OpenMeteoGeocodingProvider
from haulcast.providers.geocoding.photon import PhotonProvider
from haulcast.providers.health import ProviderHealth
from haulcast.providers.http import UpstreamClient, build_client
from haulcast.providers.routing import osrm, valhalla
from haulcast.providers.routing.chain import RoutingChain
from haulcast.providers.routing.osrm import OsrmProvider
from haulcast.providers.routing.throttle import MinIntervalGate
from haulcast.providers.routing.valhalla import ValhallaProvider
from haulcast.providers.weather.openmeteo import VARIABLE_SET_HASH, OpenMeteoProvider
from haulcast.providers.weather.scenarios import ScenarioCatalog
from haulcast.services.budget import UpstreamBudgetGuard
from haulcast.services.geocoding import GeocodingService, geocode_cache
from haulcast.services.heatmap_service import HeatmapService
from haulcast.services.plan_service import PlanService
from haulcast.services.routing import RoutingService, route_cache
from haulcast.services.rules import RULES_FILENAME, RulesDocument, load_rules_document
from haulcast.services.weather import WeatherService, WeatherServiceConfig

ROUTING_MIN_INTERVAL_S = 1.0
"""Decision D-19: calls to one routing server are strictly sequential, at least a second apart."""


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
    """Photon first, Open-Meteo second, behind the 30-day cache."""
    primary = PhotonProvider(UpstreamClient(PhotonProvider.name, client=build_client()))
    fallback = OpenMeteoGeocodingProvider(
        UpstreamClient(OpenMeteoGeocodingProvider.name, client=build_client())
    )
    chain = GeocodingChain(primary, fallback, health=ProviderHealth())
    return GeocodingService(chain, geocode_cache())


@cache
def routing_chain() -> RoutingChain:
    """Valhalla for trucks (and trips within its range), OSRM for long hauls and as fallback."""
    top_speed_kph = settings.HAULCAST_TRUCK_TOP_SPEED_KPH
    truck = ValhallaProvider(
        UpstreamClient(
            valhalla.PROVIDER_NAME,
            client=build_client(headers={"X-Client-Id": valhalla.CLIENT_ID}),
        ),
        gate=MinIntervalGate(ROUTING_MIN_INTERVAL_S),
        top_speed_kph=top_speed_kph,
    )
    car = OsrmProvider(
        UpstreamClient(osrm.PROVIDER_NAME, client=build_client()),
        gate=MinIntervalGate(ROUTING_MIN_INTERVAL_S),
        top_speed_kph=top_speed_kph,
    )
    return RoutingChain(truck, car, health=ProviderHealth())


@cache
def weather_service() -> WeatherService:
    """Open-Meteo forecasts behind the table cache and the shared upstream budget."""
    provider = OpenMeteoProvider(UpstreamClient(OpenMeteoProvider.name, client=build_client()))
    return WeatherService(
        provider,
        WeatherServiceConfig(variables_hash=VARIABLE_SET_HASH),
        budget=UpstreamBudgetGuard(),
    )


@cache
def risk_rules() -> RiskRules:
    """The validated risk rules of ``shared/risk-rules.json`` (read once per process)."""
    return load_rules_file(shared_dir() / RULES_FILENAME)


@cache
def routing_service() -> RoutingService:
    """The routing chain behind the 24-hour route cache."""
    return RoutingService(routing_chain(), route_cache())


@cache
def plan_service() -> PlanService:
    """Plans: routing, weather and scenarios scored with the shared rules."""
    return PlanService(routing_service(), weather_service(), scenario_catalog(), risk_rules())


@cache
def heatmap_service() -> HeatmapService:
    """Heatmaps of stored plans, computed from the same weather source and rules."""
    return HeatmapService(weather_service(), scenario_catalog(), risk_rules())
