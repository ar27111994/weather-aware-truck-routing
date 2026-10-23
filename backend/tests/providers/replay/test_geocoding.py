"""Tests of the geocoding replay: recorded queries verbatim, a gazetteer for the trip cities."""

import re
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from haulcast.providers.geocoding.chain import GeocodingChain
from haulcast.providers.geocoding.openmeteo import (
    OPEN_METEO_GEOCODING_URL,
    OpenMeteoGeocodingProvider,
)
from haulcast.providers.geocoding.photon import PHOTON_URL, PhotonProvider
from haulcast.providers.geocoding.text import cache_key
from haulcast.providers.health import ProviderHealth
from haulcast.providers.replay.catalog import ReplayCatalog
from haulcast.providers.replay.geocoding import OPEN_METEO_RECORDINGS, PHOTON_RECORDINGS
from haulcast.providers.replay.transport import ReplayTransport
from haulcast.providers.replay.trips import Place, gazetteer
from haulcast.services.container import GEOCODING_HTTP_POLICY
from tests.plans.support import FIXTURES
from tests.providers.replay.conftest import upstream

README_ROW = re.compile(r"^\|\s*`(?P<file>[^`]+)`\s*\|\s*(?P<status>\d{3})\s*\|\s*`(?P<url>[^`]+)`")


def open_meteo(transport: httpx.BaseTransport) -> OpenMeteoGeocodingProvider:
    return OpenMeteoGeocodingProvider(
        upstream(OpenMeteoGeocodingProvider.name, transport, policy=GEOCODING_HTTP_POLICY)
    )


def photon(transport: httpx.BaseTransport) -> PhotonProvider:
    return PhotonProvider(upstream(PhotonProvider.name, transport, policy=GEOCODING_HTTP_POLICY))


def ask_open_meteo(transport: ReplayTransport, name: str) -> httpx.Response:
    """The request the adapter sends, with the parameters it sends."""
    return transport.handle_request(
        httpx.Request(
            "GET",
            OPEN_METEO_GEOCODING_URL,
            params={
                "name": name,
                "count": 10,
                "language": "en",
                "format": "json",
                "countryCode": "US",
            },
        )
    )


def ask_photon(transport: ReplayTransport, query: str) -> httpx.Response:
    return transport.handle_request(
        httpx.Request(
            "GET",
            PHOTON_URL,
            params={"q": query, "limit": 10, "lang": "en", "lat": 39.5, "lon": -98.35},
        )
    )


def _readme_rows() -> dict[str, tuple[int, dict[str, list[str]]]]:
    rows: dict[str, tuple[int, dict[str, list[str]]]] = {}
    for line in (FIXTURES / "geocoding" / "README.md").read_text(encoding="utf-8").splitlines():
        match = README_ROW.match(line)
        if match:
            query = parse_qs(urlsplit(match["url"]).query)
            rows[match["file"]] = (int(match["status"]), query)
    return rows


# --------------------------------------------------------------------------- recorded queries


@pytest.mark.parametrize(("query", "file"), sorted(OPEN_METEO_RECORDINGS.items()))
def test_a_recorded_open_meteo_query_returns_its_recording_verbatim(
    transport: ReplayTransport, catalog: ReplayCatalog, query: str, file: str
) -> None:
    response = ask_open_meteo(transport, query)

    assert response.status_code == 200
    assert response.content == catalog.read_bytes("geocoding", file)


@pytest.mark.parametrize(("query", "file"), sorted(PHOTON_RECORDINGS.items()))
def test_a_recorded_photon_query_returns_its_recording_verbatim(
    transport: ReplayTransport, catalog: ReplayCatalog, query: str, file: str
) -> None:
    response = ask_photon(transport, query)

    assert response.status_code == 200
    assert response.content == catalog.read_bytes("geocoding", file)


@pytest.mark.parametrize("typed", ["denver, co", "  DENVER, Co ", "Denver,\tCO"])
def test_a_recorded_query_matches_by_its_normalised_form(
    transport: ReplayTransport, catalog: ReplayCatalog, typed: str
) -> None:
    response = ask_open_meteo(transport, typed)

    assert response.content == catalog.read_bytes("geocoding", "omgeo-denver-co.json")


def test_the_recorded_answers_read_through_the_real_adapters(
    transport: ReplayTransport,
) -> None:
    denver = open_meteo(transport).search("denver", limit=5)
    salt_lake = open_meteo(transport).search("salt lake", limit=5)
    chicago = photon(transport).search("chicago, il", limit=5)

    assert (denver[0].name, denver[0].region) == ("Denver", "Colorado")
    # The recording lists Salt Lake (Hawaii) first; the adapter ranks by population.
    assert ask_open_meteo(transport, "salt lake").json()["results"][0]["admin1"] == "Hawaii"
    assert (salt_lake[0].name, salt_lake[0].region) == ("Salt Lake City", "Utah")
    assert chicago[0].name == "Chicago"
    assert open_meteo(transport).search("1600 pennsylvania ave nw", limit=5) == ()
    assert photon(transport).search("1600 pennsylvania ave nw washington", limit=5)


# --------------------------------------------------------------------------- the gazetteer


@pytest.mark.parametrize("place", gazetteer(), ids=lambda place: place.name)
def test_every_trip_city_comes_first_when_typed_by_its_first_three_letters(
    transport: ReplayTransport, place: Place
) -> None:
    chain = GeocodingChain(open_meteo(transport), photon(transport), health=ProviderHealth())

    first = chain.search(place.name[:3].upper(), limit=5)[0]

    assert first.name == place.name


@pytest.mark.parametrize(
    "name", ["Salt Lake City", "Chicago", "Jersey City", "Los Angeles", "Phoenix"]
)
def test_a_gazetteer_city_has_the_label_and_position_of_its_trip_endpoint(
    transport: ReplayTransport, name: str
) -> None:
    place = next(place for place in gazetteer() if place.name == name)

    found = open_meteo(transport).search(name.lower(), limit=5)[0]
    osm = photon(transport).search(name.lower(), limit=5)[0]

    for candidate in (found, osm):
        assert candidate.label == place.label
        assert (candidate.lat, candidate.lon) == (place.lat, place.lon)
        assert (candidate.kind, candidate.country_code) == ("city", "US")
    assert found.id.startswith("geonames:")
    assert osm.id.startswith("osm:R")


def test_a_longer_prefix_narrows_the_gazetteer_and_a_label_prefix_matches(
    transport: ReplayTransport,
) -> None:
    assert [c.name for c in open_meteo(transport).search("new", limit=5)] == ["Newark"]
    assert [c.name for c in open_meteo(transport).search("salt lake city, ut", limit=5)] == [
        "Salt Lake City"
    ]


def test_a_query_that_names_no_known_place_gets_the_providers_empty_answer(
    transport: ReplayTransport, catalog: ReplayCatalog
) -> None:
    assert open_meteo(transport).search("zzzz", limit=5) == ()
    assert photon(transport).search("zzzz", limit=5) == ()
    assert ask_open_meteo(transport, "zzzz").content == catalog.read_bytes(
        "geocoding", "omgeo-one-char.json"
    )
    assert ask_photon(transport, "zzzz").json() == {"type": "FeatureCollection", "features": []}


def test_a_one_character_query_is_never_matched_against_the_gazetteer(
    transport: ReplayTransport,
) -> None:
    assert photon(transport).search("p", limit=5) == ()


def test_a_request_without_a_query_is_the_recorded_400(
    transport: ReplayTransport, catalog: ReplayCatalog
) -> None:
    no_name = transport.handle_request(
        httpx.Request("GET", OPEN_METEO_GEOCODING_URL, params={"count": 5})
    )
    no_q = transport.handle_request(httpx.Request("GET", PHOTON_URL, params={"limit": 2}))

    assert no_name.status_code == 400
    assert no_name.content == catalog.read_bytes("geocoding", "omgeo-no-name.json")
    assert no_q.status_code == 400
    assert no_q.content == catalog.read_bytes("geocoding", "photon-no-q.json")


# --------------------------------------------------------------------------- the manifest


def test_the_manifest_names_the_query_each_recording_was_made_with() -> None:
    rows = _readme_rows()

    for recordings, parameter in ((OPEN_METEO_RECORDINGS, "name"), (PHOTON_RECORDINGS, "q")):
        for query, file in recordings.items():
            status, params = rows[file]
            assert status == 200
            assert cache_key(params[parameter][0]) == query


def test_every_successful_recording_is_served_but_the_unbiased_springfield() -> None:
    served = set(OPEN_METEO_RECORDINGS.values()) | set(PHOTON_RECORDINGS.values())
    successes = {file for file, (status, _) in _readme_rows().items() if status == 200}

    assert served <= successes
    assert successes - served == {"photon-springfield-nobias.json"}


def test_the_readme_lists_every_recording_of_the_directory() -> None:
    files = {path.name for path in (FIXTURES / "geocoding").glob("*.json")}

    assert files == set(_readme_rows())
