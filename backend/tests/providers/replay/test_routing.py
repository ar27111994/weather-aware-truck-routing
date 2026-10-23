"""Tests of the routing replay: recorded trips through the real Valhalla and OSRM adapters."""

from collections.abc import Callable

import httpx
import pytest
import respx

from haulcast.providers.replay.catalog import ReplayCatalog
from haulcast.providers.replay.transport import ReplayRequestError, ReplayTransport
from haulcast.providers.replay.trips import CHICAGO_DENVER, LA_PHOENIX, SLC_DENVER, TRIPS, Trip
from haulcast.providers.routing import osrm, valhalla
from haulcast.providers.routing.base import (
    Coordinate,
    NoRouteFoundError,
    RoutingProvider,
    RoutingResult,
)
from haulcast.providers.routing.osrm import OsrmProvider
from haulcast.providers.routing.valhalla import ValhallaProvider
from haulcast.services.container import ROUTING_HTTP_POLICY
from tests.plans.support import mock_routing
from tests.providers.replay.conftest import upstream

LOAD = 38_000
DENVER_AS_GEOCODED = (-104.9847, 39.73915)
"""Denver as the recorded Open-Meteo geocoding answer places it: about half a kilometre from the
endpoint of the recorded trips."""

Maker = Callable[[httpx.BaseTransport | None], RoutingProvider]


def lonlat(point: tuple[float, float]) -> Coordinate:
    """A trip endpoint (lat, lon) as the adapters take it: (lon, lat)."""
    return point[1], point[0]


def valhalla_on(transport: httpx.BaseTransport | None) -> ValhallaProvider:
    return ValhallaProvider(
        upstream(
            valhalla.PROVIDER_NAME,
            transport,
            headers=valhalla.client_headers(),
            policy=ROUTING_HTTP_POLICY,
        )
    )


def osrm_on(transport: httpx.BaseTransport | None) -> OsrmProvider:
    return OsrmProvider(upstream(osrm.PROVIDER_NAME, transport, policy=ROUTING_HTTP_POLICY))


PROVIDERS = pytest.mark.parametrize("make", [valhalla_on, osrm_on], ids=["valhalla", "osrm"])


def _route(provider: RoutingProvider, origin: Coordinate, destination: Coordinate) -> RoutingResult:
    return provider.route(origin, destination, load_weight_lb=LOAD)


@PROVIDERS
@pytest.mark.parametrize("trip", TRIPS, ids=lambda trip: trip.name)
def test_a_recorded_trip_routes_exactly_like_its_recording(
    transport: ReplayTransport, make: Maker, trip: Trip
) -> None:
    replayed = _route(make(transport), lonlat(trip.origin), lonlat(trip.destination))

    with respx.mock(assert_all_called=False) as router:
        mock_routing(router, trip)
        recorded = _route(make(None), lonlat(trip.origin), lonlat(trip.destination))

    assert replayed.routes
    assert replayed == recorded


@PROVIDERS
def test_a_geocoded_city_centre_snaps_to_the_recorded_endpoint(
    transport: ReplayTransport, make: Maker
) -> None:
    exact = _route(make(transport), lonlat(SLC_DENVER.origin), lonlat(SLC_DENVER.destination))

    typed = _route(make(transport), lonlat(SLC_DENVER.origin), DENVER_AS_GEOCODED)

    assert typed == exact


@PROVIDERS
def test_a_position_beyond_the_snap_radius_has_no_route(
    transport: ReplayTransport, make: Maker
) -> None:
    east_of_denver = (SLC_DENVER.destination[1] + 0.05, SLC_DENVER.destination[0])

    with pytest.raises(NoRouteFoundError):
        _route(make(transport), lonlat(SLC_DENVER.origin), east_of_denver)


@PROVIDERS
def test_an_unrecorded_pair_has_no_route(transport: ReplayTransport, make: Maker) -> None:
    with pytest.raises(NoRouteFoundError):
        _route(make(transport), lonlat(LA_PHOENIX.origin), lonlat(CHICAGO_DENVER.origin))


@PROVIDERS
def test_a_recorded_trip_is_not_recorded_the_other_way_round(
    transport: ReplayTransport, make: Maker
) -> None:
    with pytest.raises(NoRouteFoundError):
        _route(make(transport), lonlat(SLC_DENVER.destination), lonlat(SLC_DENVER.origin))


def test_valhalla_says_no_path_with_its_recorded_400(
    transport: ReplayTransport, catalog: ReplayCatalog
) -> None:
    request = httpx.Request(
        "POST",
        valhalla.VALHALLA_URL,
        json={"locations": [{"lat": 0.0, "lon": 0.0}, {"lat": 1.0, "lon": 1.0}]},
    )

    response = transport.handle_request(request)

    assert response.status_code == 400
    assert response.content == catalog.read_bytes("routing", "valhalla-error-no-path.json")


def test_osrm_says_no_route_with_its_recorded_http_200(
    transport: ReplayTransport, catalog: ReplayCatalog
) -> None:
    response = transport.handle_request(
        httpx.Request("GET", f"{osrm.OSRM_URL}/0.000000,0.000000;1.000000,1.000000")
    )

    assert response.status_code == 200
    assert response.content == catalog.read_bytes("routing", "osrm-error-no-route.json")


@pytest.mark.parametrize(
    "content",
    [
        b"not json",
        b"[]",
        b'{"locations": []}',
        b'{"locations": [{"lat": 1}, {"lat": 2}]}',
        b'{"locations": [1, 2]}',
        b'{"locations": [{"lat": "north", "lon": 1}, {"lat": 2, "lon": 3}]}',
    ],
)
def test_a_valhalla_request_without_two_positions_is_a_wiring_bug(
    transport: ReplayTransport, content: bytes
) -> None:
    with pytest.raises(ReplayRequestError, match="valhalla"):
        transport.handle_request(httpx.Request("POST", valhalla.VALHALLA_URL, content=content))


@pytest.mark.parametrize("pair", ["", "1,2", "a,b;c,d", "1,2;3", "1,2;3,4;5,6"])
def test_an_osrm_request_without_two_positions_is_a_wiring_bug(
    transport: ReplayTransport, pair: str
) -> None:
    with pytest.raises(ReplayRequestError, match="osrm"):
        transport.handle_request(httpx.Request("GET", f"{osrm.OSRM_URL}/{pair}"))
