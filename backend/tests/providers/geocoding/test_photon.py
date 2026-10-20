"""Tests for the Photon geocoding adapter.

Happy paths run against real recorded responses (``tests/fixtures/providers/geocoding``) served
through ``respx``, so nothing touches the network (an unmocked request fails the test). Hostile and
malformed shapes are derived from a real feature, so they differ from reality in exactly one place.
"""

import copy
import json
import math
import re
import unicodedata
from collections.abc import Iterator, Mapping
from dataclasses import asdict
from pathlib import Path
from typing import override

import httpx
import pytest
import respx
from hypothesis import given
from hypothesis import strategies as st

from haulcast.providers.errors import (
    ProviderRateLimitedError,
    ProviderRejectedError,
    ProviderResponseError,
    ProviderUnavailableError,
)
from haulcast.providers.geocoding.base import GeocodingProvider
from haulcast.providers.geocoding.photon import PhotonProvider
from haulcast.providers.http import Pacing, QueryParams, UpstreamClient, build_client

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "providers" / "geocoding"
URL = "https://photon.komoot.io/api"
KINDS = ("country", "state", "county", "city", "district", "locality", "street", "house")
INVISIBLE_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Cn"})

type Json = dict[str, object]

MISSING = object()
"""Marks a property that a derived feature must not have at all."""


def load(name: str) -> Json:
    """Parse a recorded response from the fixtures directory."""
    document = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    assert isinstance(document, dict)
    return document


def real_feature(name: str, index: int = 0) -> Json:
    """A deep copy of one feature of a recorded response."""
    features = load(name)["features"]
    assert isinstance(features, list)
    feature = features[index]
    assert isinstance(feature, dict)
    return copy.deepcopy(feature)


DENVER = real_feature("photon-denver.json")


def make_feature(**properties: object) -> Json:
    """The real Denver feature with some properties replaced (``MISSING`` removes one)."""
    feature = copy.deepcopy(DENVER)
    current = feature["properties"]
    assert isinstance(current, dict)
    for key, value in properties.items():
        if value is MISSING:
            current.pop(key, None)
        else:
            current[key] = value
    return feature


def with_key(feature: Json, key: str, value: object) -> Json:
    """A copy of ``feature`` whose top-level ``key`` holds ``value`` (``MISSING`` removes it)."""
    derived = copy.deepcopy(feature)
    if value is MISSING:
        derived.pop(key, None)
    else:
        derived[key] = value
    return derived


def at(position: object) -> Json:
    """The real Denver feature relocated to a Point with the given ``coordinates``."""
    return with_key(DENVER, "geometry", {"type": "Point", "coordinates": position})


def payload(*features: object) -> Json:
    """A FeatureCollection holding ``features``."""
    return {"type": "FeatureCollection", "features": list(features)}


def serve(respx_mock: respx.MockRouter, body: object, *, status: int = 200) -> respx.Route:
    """Answer the Photon endpoint with a JSON ``body``."""
    return respx_mock.get(URL).respond(status, json=body)


def serve_fixture(respx_mock: respx.MockRouter, name: str, *, status: int = 200) -> respx.Route:
    """Answer the Photon endpoint with a recorded response."""
    return serve(respx_mock, load(name), status=status)


def sent_params(route: respx.Route) -> dict[str, str]:
    """The query parameters of the last request that reached ``route``."""
    return dict(route.calls.last.request.url.params)


@pytest.fixture(scope="module")
def http_client() -> Iterator[httpx.Client]:
    with build_client() as client:
        yield client


@pytest.fixture
def upstream(http_client: httpx.Client) -> UpstreamClient:
    return UpstreamClient(
        "photon",
        client=http_client,
        pacing=Pacing(sleep=lambda _seconds: None, jitter=lambda: 0.0),
    )


@pytest.fixture
def provider(upstream: UpstreamClient) -> PhotonProvider:
    return PhotonProvider(upstream)


# --------------------------------------------------------------------------- real responses


def test_denver_response_maps_to_candidates(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    serve_fixture(respx_mock, "photon-denver.json")

    results = provider.search("denver", limit=5)

    assert asdict(results[0]) == {
        "id": "osm:R1411339",
        "label": "Denver, Colorado, United States",
        "name": "Denver",
        "region": "Colorado",
        "country": "United States",
        "country_code": "US",
        "kind": "city",
        "lat": pytest.approx(39.7392364),
        "lon": pytest.approx(-104.984862),
    }
    assert [candidate.id for candidate in results] == [
        "osm:R1411339",
        "osm:R128512",
        "osm:R187699",
        "osm:R14422279",
        "osm:N154060363",
    ]
    assert [candidate.kind for candidate in results] == ["city"] * 4 + ["district"]
    assert [candidate.label for candidate in results] == [
        "Denver, Colorado, United States",
        "Denver, Iowa, United States",
        "Denver, Pennsylvania, United States",
        "Denver, Indiana, United States",
        "Denver, North Carolina, United States",
    ]


def test_coordinates_are_read_as_longitude_then_latitude(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    serve_fixture(respx_mock, "photon-denver.json")

    iowa = provider.search("denver", limit=5)[1]

    assert iowa.lat == pytest.approx(42.6713752)
    assert iowa.lon == pytest.approx(-92.3372158)


def test_chicago_response_keeps_name_street_and_city_apart(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    serve_fixture(respx_mock, "photon-chicago-il.json")

    results = provider.search("chicago, il", limit=5)

    assert [candidate.id for candidate in results] == [
        "osm:R122604",
        "osm:R13117436",
        "osm:R17607254",
        "osm:R1870546",
        "osm:R126339",
    ]
    assert [candidate.kind for candidate in results] == ["city", "house", "house", "house", "city"]
    assert [candidate.label for candidate in results] == [
        "Chicago, Illinois, United States",
        "The University of Chicago, Chicago, Illinois, United States",
        "Northwestern University Chicago Campus, Chicago, Illinois, United States",
        "The Art Institute of Chicago, Chicago, Illinois, United States",
        "Chicago Heights, Illinois, United States",
    ]


def test_address_response_prefers_the_name_over_the_street_line(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    serve_fixture(respx_mock, "photon-address.json")

    results = provider.search("1600 pennsylvania ave nw washington", limit=5)

    assert asdict(results[0]) == {
        "id": "osm:R19761182",
        "label": "White House, Washington, District of Columbia, United States",
        "name": "White House",
        "region": "District of Columbia",
        "country": "United States",
        "country_code": "US",
        "kind": "house",
        "lat": pytest.approx(38.8976387),
        "lon": pytest.approx(-77.0365525),
    }
    assert [candidate.id for candidate in results] == [
        "osm:R19761182",
        "osm:W432096036",
        "osm:N603191102",
        "osm:N2276095941",
        "osm:N12941543310",
    ]
    assert {candidate.kind for candidate in results} == {"house"}


def test_a_house_without_a_name_is_labelled_with_its_street_line(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    nameless = real_feature("photon-address.json")
    properties = nameless["properties"]
    assert isinstance(properties, dict)
    del properties["name"]
    serve(respx_mock, payload(nameless))

    (result,) = provider.search("1600 pennsylvania ave nw washington", limit=5)

    assert result.name == "1600 Pennsylvania Avenue Northwest"
    assert result.label == (
        "1600 Pennsylvania Avenue Northwest, Washington, District of Columbia, United States"
    )
    assert result.kind == "house"


def test_partial_query_without_bias_maps_a_country_a_county_and_non_ascii_names(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    serve_fixture(respx_mock, "photon-partial-den.json")

    results = provider.search("den", limit=5)

    assert asdict(results[0]) == {
        "id": "osm:R50046",
        "label": "Denmark",
        "name": "Denmark",
        "region": None,
        "country": "Denmark",
        "country_code": "DK",
        "kind": "country",
        "lat": pytest.approx(55.670249),
        "lon": pytest.approx(10.3333283),
    }
    assert [candidate.kind for candidate in results] == [
        "country",
        "city",
        "city",
        "city",
        "county",
    ]
    assert results[2].name == "Dennebr\u0153ucq"
    assert results[2].label == "Dennebr\u0153ucq, Hauts-de-France, France"
    assert results[4].label == "Denton, Texas, United States"


def test_us_biased_partial_query_maps_streets_and_other_features(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    serve_fixture(respx_mock, "photon-partial-denv-us-bias.json")

    results = provider.search("denv", limit=5)

    assert [candidate.kind for candidate in results] == [
        "city",
        "other",
        "street",
        "street",
        "street",
    ]
    assert results[1].label == "Denv\u00e9, Ngan'ha, Adamawa, Cameroon"
    assert results[1].country_code == "CM"
    # The same street name in three towns: distinct ids, so all three are kept.
    assert [candidate.label for candidate in results[2:]] == [
        "Denver Street, Nelson, Nebraska, United States",
        "Denver Street, Holdrege, Nebraska, United States",
        "Denver Street, Rush Center, Kansas, United States",
    ]


def test_springfield_without_bias_drops_a_city_that_repeats_the_name(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    serve_fixture(respx_mock, "photon-springfield-nobias.json")

    results = provider.search("springfield", limit=10)

    assert [candidate.label for candidate in results] == [
        f"Springfield, {state}, United States"
        for state in (
            "Massachusetts",
            "Illinois",
            "Missouri",
            "Ohio",
            "Oregon",
            "Vermont",
            "Kentucky",
            "Georgia",
        )
    ]
    assert results[0].id == "osm:R1181618"


def test_springfield_with_a_missouri_bias_maps_every_kind_of_feature(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    serve_fixture(respx_mock, "photon-springfield-bias-mo.json")

    results = provider.search("springfield", limit=10)

    assert [candidate.kind for candidate in results] == [
        "city",
        "house",
        "house",
        "locality",
        "locality",
        "locality",
        "locality",
        "other",
    ]
    assert [candidate.label for candidate in results] == [
        "Springfield, Missouri, United States",
        "Springfield-Branson National Airport, Springfield, Missouri, United States",
        "Springfield Catholic High School, Springfield, Missouri, United States",
        "Springfield Highland Estates, Springfield, Missouri, United States",
        "Springfield Plaza, Springfield, Missouri, United States",
        "Springfield Shopping Center, Springfield, Missouri, United States",
        "Springfield Farms, Missouri, United States",
        "Springfield National Cemetery, Springfield, Missouri, United States",
    ]


# --------------------------------------------------------------------------- the request


def test_request_carries_the_query_the_us_bias_and_twice_the_limit(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    route = serve_fixture(respx_mock, "photon-denver.json")

    provider.search("denver", limit=5)

    assert route.call_count == 1
    assert sent_params(route) == {
        "q": "denver",
        "limit": "10",
        "lang": "en",
        "lat": "39.5",
        "lon": "-98.35",
    }


@pytest.mark.parametrize(
    ("limit", "requested"),
    [(1, "2"), (2, "4"), (5, "10"), (9, "18"), (10, "20"), (11, "20"), (50, "20")],
)
def test_limit_is_doubled_for_deduplication_and_capped_at_twenty(
    respx_mock: respx.MockRouter, provider: PhotonProvider, limit: int, requested: str
) -> None:
    route = serve(respx_mock, payload())

    provider.search("denver", limit=limit)

    assert sent_params(route)["limit"] == requested


def test_a_hostile_query_stays_inside_the_q_parameter(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    hostile = "denver&limit=50&lat=0&lon=0#fragment=1 ?x=y"
    route = serve(respx_mock, payload())

    provider.search(hostile, limit=1)

    request = route.calls.last.request
    assert sorted(key for key, _ in request.url.params.multi_items()) == [
        "lang",
        "lat",
        "limit",
        "lon",
        "q",
    ]
    assert request.url.params["q"] == hostile
    assert request.url.params["limit"] == "2"
    assert request.url.params["lat"] == "39.5"
    assert request.url.host == "photon.komoot.io"


def test_url_and_bias_are_configurable(
    respx_mock: respx.MockRouter, upstream: UpstreamClient
) -> None:
    route = respx_mock.get("https://photon.example.test/v2/api").respond(json=payload())
    custom = PhotonProvider(
        upstream, url="https://photon.example.test/v2/api", bias_lat=51.5, bias_lon=-0.25
    )

    custom.search("london", limit=3)

    assert sent_params(route) == {
        "q": "london",
        "limit": "6",
        "lang": "en",
        "lat": "51.5",
        "lon": "-0.25",
    }


@pytest.mark.parametrize("limit", [0, -1, -50])
def test_a_limit_below_one_is_a_caller_bug_and_sends_nothing(
    respx_mock: respx.MockRouter, provider: PhotonProvider, limit: int
) -> None:
    # No route is registered: a request would fail with an unmocked-request error, not ValueError.
    with pytest.raises(ValueError, match="limit"):
        provider.search("denver", limit=limit)
    assert respx_mock.calls.call_count == 0


# --------------------------------------------------------------------------- ordering, dedupe, cut


def test_results_are_cut_to_the_limit_in_provider_order(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    serve_fixture(respx_mock, "photon-denver.json")

    results = provider.search("denver", limit=2)

    assert [candidate.id for candidate in results] == ["osm:R1411339", "osm:R128512"]


def test_duplicate_ids_keep_their_first_occurrence(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    serve(
        respx_mock,
        payload(
            make_feature(osm_id=1, name="First"),
            make_feature(osm_id=2, name="Second"),
            make_feature(osm_id=1, name="Duplicate of the first"),
            make_feature(osm_id=3, name="Third"),
        ),
    )

    results = provider.search("x", limit=10)

    assert [(candidate.id, candidate.name) for candidate in results] == [
        ("osm:R1", "First"),
        ("osm:R2", "Second"),
        ("osm:R3", "Third"),
    ]


def test_duplicates_are_removed_before_the_cut(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    serve(
        respx_mock,
        payload(
            make_feature(osm_id=1),
            make_feature(osm_id=1),
            make_feature(osm_id=2),
            make_feature(osm_id=3),
        ),
    )

    results = provider.search("x", limit=2)

    assert [candidate.id for candidate in results] == ["osm:R1", "osm:R2"]


def test_the_same_number_under_another_osm_type_is_another_place(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    serve(
        respx_mock,
        payload(
            make_feature(osm_type="N", osm_id=7),
            make_feature(osm_type="W", osm_id=7),
            make_feature(osm_type="R", osm_id=7),
        ),
    )

    results = provider.search("x", limit=10)

    assert [candidate.id for candidate in results] == ["osm:N7", "osm:W7", "osm:R7"]


def test_no_features_means_no_candidates(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    serve(respx_mock, payload())

    assert provider.search("zzzzzz", limit=5) == ()


# --------------------------------------------------------------------------- skipped features

BAD_FEATURES = [
    pytest.param(make_feature(name=MISSING), id="no-name-and-no-street"),
    pytest.param(make_feature(name="  \u200b "), id="blank-name"),
    pytest.param(make_feature(name=123), id="non-text-name"),
    pytest.param(make_feature(name=MISSING, housenumber="1600"), id="housenumber-without-street"),
    pytest.param(make_feature(name=MISSING, street="   "), id="blank-street"),
    pytest.param(make_feature(osm_type=MISSING), id="no-osm-type"),
    pytest.param(make_feature(osm_type="X"), id="unknown-osm-type"),
    pytest.param(make_feature(osm_type="r"), id="lower-case-osm-type"),
    pytest.param(make_feature(osm_type=["R"]), id="unhashable-osm-type"),
    pytest.param(make_feature(osm_id=MISSING), id="no-osm-id"),
    pytest.param(make_feature(osm_id="1411339"), id="text-osm-id"),
    pytest.param(make_feature(osm_id=0), id="zero-osm-id"),
    pytest.param(make_feature(osm_id=-5), id="negative-osm-id"),
    pytest.param(make_feature(osm_id=True), id="boolean-osm-id"),
    pytest.param(make_feature(osm_id=1.5), id="fractional-osm-id"),
    pytest.param(make_feature(osm_id=2**63), id="osm-id-beyond-64-bits"),
    pytest.param(with_key(DENVER, "properties", MISSING), id="no-properties"),
    pytest.param(with_key(DENVER, "properties", "Denver"), id="non-object-properties"),
    pytest.param(with_key(DENVER, "geometry", MISSING), id="no-geometry"),
    pytest.param(with_key(DENVER, "geometry", None), id="null-geometry"),
    pytest.param(with_key(DENVER, "geometry", "Point"), id="non-object-geometry"),
    pytest.param(
        with_key(DENVER, "geometry", {"type": "LineString", "coordinates": [[0, 0], [1, 1]]}),
        id="not-a-point",
    ),
    pytest.param(with_key(DENVER, "geometry", {"type": "Point"}), id="no-coordinates"),
    pytest.param(at("-104.98,39.73"), id="text-coordinate-pair"),
    pytest.param(at([-104.98]), id="a-single-coordinate"),
    pytest.param(at(["-104.98", "39.73"]), id="text-coordinates"),
    pytest.param(at([True, False]), id="boolean-coordinates"),
    pytest.param(at([None, None]), id="null-coordinates"),
    pytest.param(at([0.0, 90.0001]), id="latitude-above-90"),
    pytest.param(at([0.0, -90.0001]), id="latitude-below-minus-90"),
    pytest.param(at([180.0001, 0.0]), id="longitude-above-180"),
    pytest.param(at([-180.0001, 0.0]), id="longitude-below-minus-180"),
    pytest.param(at([39.7392364, -104.984862]), id="latitude-and-longitude-swapped"),
    pytest.param(at([10**400, 0]), id="integer-too-big-for-a-float"),
]


@pytest.mark.parametrize("bad", BAD_FEATURES)
def test_unusable_features_are_skipped_without_disturbing_their_neighbours(
    respx_mock: respx.MockRouter, provider: PhotonProvider, bad: Json
) -> None:
    serve(
        respx_mock,
        payload(make_feature(osm_id=1), bad, make_feature(osm_id=2)),
    )

    results = provider.search("x", limit=10)

    assert [candidate.id for candidate in results] == ["osm:R1", "osm:R2"]


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_non_finite_coordinates_are_skipped(
    respx_mock: respx.MockRouter, provider: PhotonProvider, value: float
) -> None:
    # Python's json module happily parses the non-standard NaN/Infinity tokens, so a hostile or
    # buggy upstream can deliver them; httpx refuses to encode them, hence the raw body.
    body = json.dumps(payload(at([value, 1.0]), at([1.0, value]), make_feature(osm_id=2)))
    respx_mock.get(URL).respond(
        200, content=body.encode(), headers={"content-type": "application/json"}
    )

    results = provider.search("x", limit=10)

    assert [candidate.id for candidate in results] == ["osm:R2"]


@pytest.mark.parametrize("corner", [(-180.0, -90.0), (180.0, 90.0), (-180.0, 90.0), (0, 0)])
def test_the_extreme_valid_coordinates_are_accepted(
    respx_mock: respx.MockRouter, provider: PhotonProvider, corner: tuple[float, float]
) -> None:
    serve(respx_mock, payload(at(list(corner))))

    (result,) = provider.search("x", limit=1)

    assert (result.lon, result.lat) == corner


# --------------------------------------------------------------------------- labels and kinds

LABEL_CASES = [
    pytest.param({}, "Denver", "Denver, Colorado, United States", id="name-state-country"),
    pytest.param(
        {"name": "Springfield", "city": "Springfield", "state": "Massachusetts"},
        "Springfield",
        "Springfield, Massachusetts, United States",
        id="a-city-repeating-the-name-is-dropped",
    ),
    pytest.param(
        {"city": "DENVER"},
        "Denver",
        "Denver, Colorado, United States",
        id="a-city-repeating-the-name-ignoring-case-is-dropped",
    ),
    pytest.param(
        {"name": "Denver Zoo", "city": "Denver"},
        "Denver Zoo",
        "Denver Zoo, Denver, Colorado, United States",
        id="a-city-differing-from-the-name-is-kept",
    ),
    pytest.param(
        {"name": "New York", "state": "New York"},
        "New York",
        "New York, United States",
        id="a-state-repeating-the-name-is-dropped",
    ),
    pytest.param({"state": MISSING}, "Denver", "Denver, United States", id="no-state"),
    pytest.param({"country": MISSING}, "Denver", "Denver, Colorado", id="no-country"),
    pytest.param(
        {"state": MISSING, "country": MISSING}, "Denver", "Denver", id="name-and-nothing-else"
    ),
    pytest.param(
        {"name": "Denmark", "state": MISSING, "country": "Denmark"},
        "Denmark",
        "Denmark",
        id="a-country-repeating-the-name-is-dropped",
    ),
    pytest.param(
        {
            "name": MISSING,
            "housenumber": "1600",
            "street": "Pennsylvania Avenue Northwest",
            "city": "Washington",
            "state": "District of Columbia",
        },
        "1600 Pennsylvania Avenue Northwest",
        "1600 Pennsylvania Avenue Northwest, Washington, District of Columbia, United States",
        id="street-line-when-there-is-no-name",
    ),
    pytest.param(
        {"name": MISSING, "street": "Main Street"},
        "Main Street",
        "Main Street, Colorado, United States",
        id="street-without-housenumber",
    ),
    pytest.param(
        {"name": MISSING, "street": "Main Street", "housenumber": " \u200b "},
        "Main Street",
        "Main Street, Colorado, United States",
        id="blank-housenumber-is-ignored",
    ),
    pytest.param(
        {"name": "Name Wins", "street": "Ignored Street", "housenumber": "9"},
        "Name Wins",
        "Name Wins, Colorado, United States",
        id="the-name-beats-the-street-line",
    ),
    pytest.param(
        {"name": "<script>alert(1)</script>"},
        "<script>alert(1)</script>",
        "<script>alert(1)</script>, Colorado, United States",
        id="markup-comes-back-verbatim",
    ),
    pytest.param(
        {"name": "Den\x00ver\u202e", "state": "Colo\u200brado", "country": "United\tStates"},
        "Denver",
        "Denver, Colorado, United States",
        id="control-characters-never-survive",
    ),
    pytest.param(
        {"name": "  Den   ver \n", "state": "\tColorado  "},
        "Den ver",
        "Den ver, Colorado, United States",
        id="whitespace-is-collapsed",
    ),
    pytest.param(
        {"name": "Z\u00fcrich", "state": "Z\u00fcrich", "country": "Schweiz"},
        "Z\u00fcrich",
        "Z\u00fcrich, Schweiz",
        id="accented-names",
    ),
    pytest.param(
        {"name": "\u6771\u4eac", "state": "\u6771\u4eac\u90fd", "country": "\u65e5\u672c"},
        "\u6771\u4eac",
        "\u6771\u4eac, \u6771\u4eac\u90fd, \u65e5\u672c",
        id="cjk-names",
    ),
    pytest.param(
        {"state": 5, "country": ["US"], "city": {"a": 1}},
        "Denver",
        "Denver",
        id="non-text-parts-are-ignored",
    ),
]


@pytest.mark.parametrize(("overrides", "name", "label"), LABEL_CASES)
def test_name_and_label_are_built_from_the_parts_that_exist(
    respx_mock: respx.MockRouter,
    provider: PhotonProvider,
    overrides: dict[str, object],
    name: str,
    label: str,
) -> None:
    serve(respx_mock, payload(make_feature(**overrides)))

    (result,) = provider.search("x", limit=1)

    assert (result.name, result.label) == (name, label)


def test_overlong_text_is_capped_at_two_hundred_characters(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    serve(respx_mock, payload(make_feature(name="x" * 300, state="y" * 300)))

    (result,) = provider.search("x", limit=1)

    assert result.name == "x" * 200
    assert result.region == "y" * 200
    assert result.label == "x" * 200


@pytest.mark.parametrize(
    ("overrides", "region", "country"),
    [
        pytest.param({}, "Colorado", "United States", id="both-present"),
        pytest.param({"state": MISSING}, None, "United States", id="no-state"),
        pytest.param({"state": "  "}, None, "United States", id="blank-state"),
        pytest.param({"country": MISSING}, "Colorado", None, id="no-country"),
        pytest.param({"state": None, "country": None}, None, None, id="nulls"),
        pytest.param({"state": " Colo\u200brado "}, "Colorado", "United States", id="cleaned"),
    ],
)
def test_region_and_country_are_none_when_absent_or_blank(
    respx_mock: respx.MockRouter,
    provider: PhotonProvider,
    overrides: dict[str, object],
    region: str | None,
    country: str | None,
) -> None:
    serve(respx_mock, payload(make_feature(**overrides)))

    (result,) = provider.search("x", limit=1)

    assert (result.region, result.country) == (region, country)


@pytest.mark.parametrize(
    ("raw", "kind"),
    [
        *[pytest.param(kind, kind, id=kind) for kind in KINDS],
        pytest.param("other", "other", id="other"),
        pytest.param("boundary", "other", id="unknown-type"),
        pytest.param("City", "other", id="matching-is-exact"),
        pytest.param(MISSING, "other", id="no-type"),
        pytest.param(None, "other", id="null-type"),
        pytest.param(5, "other", id="numeric-type"),
        pytest.param(["city"], "other", id="unhashable-type"),
    ],
)
def test_kind_is_the_photon_type_when_known_and_other_otherwise(
    respx_mock: respx.MockRouter, provider: PhotonProvider, raw: object, kind: str
) -> None:
    serve(respx_mock, payload(make_feature(type=raw)))

    (result,) = provider.search("x", limit=1)

    assert result.kind == kind


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        pytest.param("US", "US", id="upper-case"),
        pytest.param("us", "US", id="lower-case-is-upper-cased"),
        pytest.param(MISSING, None, id="absent"),
        pytest.param(None, None, id="null"),
        pytest.param("", None, id="empty"),
        pytest.param("USA", None, id="three-letters"),
        pytest.param("U1", None, id="not-letters"),
        pytest.param(5, None, id="number"),
    ],
)
def test_country_code_is_an_upper_case_alpha2_code_or_none(
    respx_mock: respx.MockRouter, provider: PhotonProvider, raw: object, code: str | None
) -> None:
    serve(respx_mock, payload(make_feature(countrycode=raw)))

    (result,) = provider.search("x", limit=1)

    assert result.country_code == code


# --------------------------------------------------------------------------- malformed documents

MALFORMED_DOCUMENTS = [
    pytest.param([], id="array"),
    pytest.param("features", id="string"),
    pytest.param(42, id="number"),
    pytest.param(None, id="null"),
    pytest.param({}, id="no-features"),
    pytest.param({"features": None}, id="null-features"),
    pytest.param({"features": {}}, id="features-object"),
    pytest.param({"features": "none"}, id="features-string"),
    pytest.param({"features": [1]}, id="number-entry"),
    pytest.param({"features": [None]}, id="null-entry"),
    pytest.param({"features": ["feature"]}, id="string-entry"),
    pytest.param({"features": [[]]}, id="array-entry"),
    pytest.param(payload(make_feature(osm_id=1), 5), id="bad-entry-after-a-good-one"),
    pytest.param(payload(5, make_feature(osm_id=1)), id="bad-entry-before-a-good-one"),
]


@pytest.mark.parametrize("document", MALFORMED_DOCUMENTS)
def test_a_document_that_is_not_a_feature_collection_is_a_response_error(
    respx_mock: respx.MockRouter, provider: PhotonProvider, document: object
) -> None:
    serve(respx_mock, document)

    with pytest.raises(ProviderResponseError) as excinfo:
        provider.search("x", limit=5)

    assert excinfo.value.provider == "photon"


def test_a_response_error_never_echoes_the_upstream_document(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    canary = "CANARY-9f1c-do-not-log"
    serve(respx_mock, {"features": canary})

    with pytest.raises(ProviderResponseError) as excinfo:
        provider.search("x", limit=5)

    assert canary not in str(excinfo.value)


# --------------------------------------------------------------------------- upstream failures


@pytest.mark.parametrize(
    ("fixture", "message"),
    [
        ("photon-lang-unsupported.json", "HTTP 400"),
        ("photon-bad-lat.json", "HTTP 400"),
        ("photon-no-q.json", "q parameter is required when no include categories are specified"),
    ],
)
def test_a_recorded_http_400_is_a_rejection(
    respx_mock: respx.MockRouter, provider: PhotonProvider, fixture: str, message: str
) -> None:
    serve_fixture(respx_mock, fixture, status=400)

    with pytest.raises(ProviderRejectedError, match=message) as excinfo:
        provider.search("x", limit=5)

    assert excinfo.value.status == 400
    assert excinfo.value.provider == "photon"


def test_a_server_error_is_unavailable_after_the_retry_budget(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    route = respx_mock.get(URL).respond(503)

    with pytest.raises(ProviderUnavailableError, match="HTTP 503"):
        provider.search("x", limit=5)

    assert route.call_count == 3


def test_rate_limiting_surfaces_with_the_upstream_hint(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    route = respx_mock.get(URL).respond(429, headers={"Retry-After": "2"})

    with pytest.raises(ProviderRateLimitedError) as excinfo:
        provider.search("x", limit=5)

    assert excinfo.value.retry_after_s == pytest.approx(2.0)
    assert route.call_count == 2


def test_a_timeout_is_unavailable(respx_mock: respx.MockRouter, provider: PhotonProvider) -> None:
    respx_mock.get(URL).mock(side_effect=httpx.ConnectTimeout("timed out"))

    with pytest.raises(ProviderUnavailableError, match="timed out"):
        provider.search("x", limit=5)


def test_a_body_that_is_not_json_is_a_response_error(
    respx_mock: respx.MockRouter, provider: PhotonProvider
) -> None:
    respx_mock.get(URL).respond(200, text="<html>gateway hiccup</html>")

    with pytest.raises(ProviderResponseError, match="not valid JSON"):
        provider.search("x", limit=5)


# --------------------------------------------------------------------------- contract


def name_of(geocoder: GeocodingProvider) -> str:
    """Accepts anything that structurally is a geocoding provider (checked by mypy at the call)."""
    return geocoder.name


def test_provider_satisfies_the_geocoding_provider_protocol(provider: PhotonProvider) -> None:
    assert name_of(provider) == "photon"


# --------------------------------------------------------------------------- fuzzing


class CannedClient(UpstreamClient):
    """An ``UpstreamClient`` that answers every GET with one fixed document, without any HTTP."""

    def __init__(self, http_client: httpx.Client, document: object) -> None:
        super().__init__("photon", client=http_client)
        self.document = document

    @override
    def get_json(
        self,
        url: str,
        *,
        params: QueryParams | None = None,
        headers: Mapping[str, str] | None = None,
        cost: int = 1,
    ) -> object:
        return self.document


NASTY_TEXT = st.text(
    alphabet=st.sampled_from([*"aeN Z ,.-<>&", "\x00", "\u200b", "\u202e", "\t", "\n", "\u00e9"]),
    max_size=24,
)
NUMBERS = st.one_of(
    st.integers(min_value=-300, max_value=300),
    st.floats(),
    st.sampled_from([10**400, -(10**400), 2**63, 2**63 - 1, math.nan, math.inf, -math.inf]),
)
HOSTILE = st.one_of(
    st.none(),
    st.booleans(),
    NUMBERS,
    st.text(alphabet="aN ,.-", max_size=6),
    st.sampled_from([[], {}, ["R"], {"a": 1}, [[]], "Point", "Feature"]),
)
JSON_VALUES = st.recursive(
    HOSTILE,
    lambda children: st.one_of(
        st.lists(children, max_size=3),
        st.dictionaries(
            st.sampled_from(["features", "properties", "geometry", "type", "a"]),
            children,
            max_size=3,
        ),
    ),
    max_leaves=6,
)


def mostly(valid: st.SearchStrategy[object]) -> st.SearchStrategy[object]:
    """``valid`` three times out of four, a hostile scalar or container otherwise."""
    return st.one_of(valid, valid, valid, HOSTILE)


FUZZ_PROPERTIES = st.fixed_dictionaries(
    {
        "osm_type": mostly(st.sampled_from(["N", "W", "R"])),
        "osm_id": mostly(st.one_of(st.integers(min_value=1, max_value=2**63 - 1), NUMBERS)),
        "name": mostly(NASTY_TEXT),
    },
    optional={
        "street": mostly(NASTY_TEXT),
        "housenumber": mostly(NASTY_TEXT),
        "city": mostly(NASTY_TEXT),
        "state": mostly(NASTY_TEXT),
        "country": mostly(NASTY_TEXT),
        "countrycode": mostly(st.sampled_from(["US", "us", "DK", "usa"])),
        "type": mostly(st.sampled_from([*KINDS, "other", "bogus"])),
    },
)
FUZZ_GEOMETRY = st.one_of(
    HOSTILE,
    st.fixed_dictionaries(
        {
            "type": st.sampled_from(["Point", "Point", "Polygon"]),
            "coordinates": st.one_of(st.lists(NUMBERS, min_size=2, max_size=3), HOSTILE),
        }
    ),
    st.just({"type": "Point", "coordinates": [-104.98, 39.73]}),
)
FUZZ_FEATURE = st.fixed_dictionaries(
    {"properties": mostly(FUZZ_PROPERTIES), "geometry": FUZZ_GEOMETRY}
)
FUZZ_DOCUMENT = st.one_of(
    JSON_VALUES,
    st.fixed_dictionaries({"features": st.lists(mostly(FUZZ_FEATURE), max_size=6)}),
    st.fixed_dictionaries({"features": st.lists(FUZZ_FEATURE, max_size=6)}),
)


def assert_clean_text(text: str) -> None:
    """Provider text reaches clients only cleaned and capped."""
    assert 0 < len(text) <= 200
    assert text == text.strip()
    for char in text:
        assert unicodedata.category(char) not in INVISIBLE_CATEGORIES
        assert char == " " or not char.isspace()


@given(document=FUZZ_DOCUMENT, limit=st.integers(min_value=1, max_value=12))
def test_any_upstream_document_yields_valid_candidates_or_a_response_error(
    http_client: httpx.Client, document: object, limit: int
) -> None:
    provider = PhotonProvider(CannedClient(http_client, document))

    try:
        results = provider.search("x", limit=limit)
    except ProviderResponseError:
        return

    assert len(results) <= limit
    assert len({candidate.id for candidate in results}) == len(results)
    for candidate in results:
        assert re.fullmatch(r"osm:[NWR][1-9][0-9]{0,18}", candidate.id)
        assert candidate.kind in {*KINDS, "other"}
        assert -90 <= candidate.lat <= 90
        assert -180 <= candidate.lon <= 180
        assert candidate.country_code is None or re.fullmatch(r"[A-Z]{2}", candidate.country_code)
        for text in (candidate.name, candidate.label):
            assert_clean_text(text)
        for optional in (candidate.region, candidate.country):
            if optional is not None:
                assert_clean_text(optional)
