"""Tests of the replay transport: five provider endpoints, nothing else, no network."""

import re
import socket
from pathlib import Path

import httpx
import pytest

from haulcast.providers.geocoding.openmeteo import OPEN_METEO_GEOCODING_URL
from haulcast.providers.geocoding.photon import PHOTON_URL
from haulcast.providers.replay.catalog import ReplayCatalogError
from haulcast.providers.replay.transport import (
    ReplayRequestError,
    ReplayTransport,
    build_replay_transport,
)
from haulcast.providers.replay.trips import SLC_DENVER
from haulcast.providers.routing import osrm, valhalla
from haulcast.providers.weather.openmeteo import DEFAULT_URL as OPEN_METEO_FORECAST_URL
from tests.plans.support import FIXTURES

ORIGIN, DESTINATION = SLC_DENVER.origin, SLC_DENVER.destination


def ask_every_provider(transport: httpx.BaseTransport) -> list[int]:
    """One request to each of the five provider endpoints; the status codes that come back."""
    locations = [{"lat": lat, "lon": lon} for lat, lon in (ORIGIN, DESTINATION)]
    pair = f"{ORIGIN[1]:.6f},{ORIGIN[0]:.6f};{DESTINATION[1]:.6f},{DESTINATION[0]:.6f}"
    form = {
        "latitude": "39.7",
        "longitude": "-105.0",
        "start_hour": "2026-10-20T14:00",
        "end_hour": "2026-10-20T15:00",
    }
    with httpx.Client(transport=transport) as client:
        answers = [
            client.post(valhalla.VALHALLA_URL, json={"locations": locations}),
            client.get(f"{osrm.OSRM_URL}/{pair}"),
            client.post(OPEN_METEO_FORECAST_URL, data=form),
            client.get(OPEN_METEO_GEOCODING_URL, params={"name": "denver"}),
            client.get(PHOTON_URL, params={"q": "denver"}),
        ]
    return [answer.status_code for answer in answers]


def test_every_provider_endpoint_is_answered(transport: ReplayTransport) -> None:
    assert ask_every_provider(transport) == [200, 200, 200, 200, 200]


def test_replay_never_touches_the_network(
    transport: ReplayTransport, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("replay mode made a real network call")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "getaddrinfo", refuse)

    assert ask_every_provider(transport) == [200, 200, 200, 200, 200]


@pytest.mark.parametrize(
    ("method", "url"),
    [
        pytest.param("GET", "https://example.com/", id="another-host"),
        pytest.param("GET", "https://photon.komoot.io/other", id="another-path"),
        pytest.param("GET", valhalla.VALHALLA_URL, id="another-method-valhalla"),
        pytest.param("POST", f"{PHOTON_URL}?q=secret", id="another-method-photon"),
        pytest.param("GET", "http://photon.komoot.io/api?q=x", id="plain-http"),
    ],
)
def test_a_request_outside_the_catalog_is_a_wiring_bug_named_without_its_query(
    transport: ReplayTransport, method: str, url: str
) -> None:
    target = httpx.URL(url)
    named = re.escape(f"{method} {target.host}{target.path}")

    with pytest.raises(ReplayRequestError, match=named) as excinfo:
        transport.handle_request(httpx.Request(method, url))

    assert "secret" not in str(excinfo.value)


def test_the_transport_is_built_from_a_directory() -> None:
    assert isinstance(build_replay_transport(FIXTURES), ReplayTransport)


def test_building_the_transport_on_a_missing_directory_stops_with_the_catalog_error(
    tmp_path: Path,
) -> None:
    with pytest.raises(ReplayCatalogError, match="not a directory"):
        build_replay_transport(tmp_path / "no-such-catalog")
