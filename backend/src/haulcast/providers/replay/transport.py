"""The replay transport: the five provider endpoints, answered from the catalog.

Plug it into :func:`~haulcast.providers.http.build_client` and the real adapters talk to recordings
instead of the network: the URLs are the adapters' own constants, so a provider that moves its
endpoint moves the replay with it. A request that matches none of the five endpoints raises
:class:`~haulcast.providers.replay.errors.ReplayRequestError`; nothing falls through to a socket.
"""

from collections.abc import Callable
from dataclasses import dataclass
from functools import partial
from pathlib import Path

import httpx

from haulcast.providers.geocoding.openmeteo import OPEN_METEO_GEOCODING_URL
from haulcast.providers.geocoding.photon import PHOTON_URL
from haulcast.providers.replay.catalog import ReplayCatalog
from haulcast.providers.replay.errors import ReplayRequestError
from haulcast.providers.replay.geocoding import GeocodingReplay
from haulcast.providers.replay.routing import RoutingReplay
from haulcast.providers.replay.weather import WeatherSample, forecast_response, recorded_week
from haulcast.providers.routing import osrm, valhalla
from haulcast.providers.weather.openmeteo import DEFAULT_URL as OPEN_METEO_FORECAST_URL

__all__ = ["ReplayRequestError", "ReplayTransport", "build_replay_transport"]


@dataclass(frozen=True, slots=True)
class _Endpoint:
    """One provider endpoint and the function that answers requests to it."""

    method: str
    url: httpx.URL
    answer: Callable[[httpx.Request], httpx.Response]

    def serves(self, request: httpx.Request) -> bool:
        """Whether ``request`` is for this endpoint: method, scheme, host and path (or below)."""
        target = request.url
        return (
            request.method == self.method
            and target.scheme == self.url.scheme
            and target.host == self.url.host
            and (target.path == self.url.path or target.path.startswith(f"{self.url.path}/"))
        )


class ReplayTransport(httpx.BaseTransport):
    """An ``httpx`` transport that answers the provider endpoints from a replay catalog."""

    def __init__(self, catalog: ReplayCatalog) -> None:
        """Serve the recordings of ``catalog``.

        Raises:
            ReplayCatalogError: the catalog lacks the sample that gives forecasts their shape.
        """
        routing = RoutingReplay(catalog)
        geocoding = GeocodingReplay(catalog)
        sample = WeatherSample.load(catalog)
        forecast = partial(forecast_response, script=recorded_week(sample), sample=sample)
        self._endpoints = (
            _Endpoint("POST", httpx.URL(valhalla.VALHALLA_URL), routing.valhalla),
            _Endpoint("GET", httpx.URL(osrm.OSRM_URL), routing.osrm),
            _Endpoint("POST", httpx.URL(OPEN_METEO_FORECAST_URL), forecast),
            _Endpoint("GET", httpx.URL(OPEN_METEO_GEOCODING_URL), geocoding.open_meteo),
            _Endpoint("GET", httpx.URL(PHOTON_URL), geocoding.photon),
        )

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        """Answer ``request`` from the catalog.

        Raises:
            ReplayRequestError: no provider endpoint matches the request (the message names the
                method, host and path, never the query or the body).
        """
        for endpoint in self._endpoints:
            if endpoint.serves(request):
                return endpoint.answer(request)
        raise ReplayRequestError(
            f"no recorded answer for {request.method} {request.url.host}{request.url.path}"
        )


def build_replay_transport(root: Path) -> ReplayTransport:
    """Open the catalog at ``root`` and return the transport that serves it.

    Raises:
        ReplayCatalogError: ``root`` is not a complete catalog.
    """
    return ReplayTransport(ReplayCatalog(root))
