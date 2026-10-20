"""Tests for the Open-Meteo geocoding adapter (the city-level fallback).

Happy paths run against real recorded responses (``tests/fixtures/providers/geocoding``) served
through ``respx``, so nothing touches the network (an unmocked request fails the test). Hostile and
malformed shapes are derived from a real result, so they differ from reality in exactly one place.
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
from haulcast.providers.geocoding.openmeteo import OpenMeteoGeocodingProvider
from haulcast.providers.http import QueryParams, UpstreamClient, build_client

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "providers" / "geocoding"
URL = "https://geocoding-api.open-meteo.com/v1/search"
KINDS = frozenset({"city", "state", "county", "country", "locality"})
INVISIBLE_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Cn"})

type Json = dict[str, object]

MISSING = object()
"""Marks a field that a derived result must not have at all."""


def load(name: str) -> Json:
    """Parse a recorded response from the fixtures directory."""
    document = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    assert isinstance(document, dict)
    return document


def real_result(name: str, index: int = 0) -> Json:
    """A deep copy of one entry of a recorded response's ``results``."""
    results = load(name)["results"]
    assert isinstance(results, list)
    result = results[index]
    assert isinstance(result, dict)
    return copy.deepcopy(result)


DENVER = real_result("omgeo-denver.json")


def make_result(**fields: object) -> Json:
    """The real Denver result with some fields replaced (``MISSING`` removes one)."""
    result = copy.deepcopy(DENVER)
    for key, value in fields.items():
        if value is MISSING:
            result.pop(key, None)
        else:
            result[key] = value
    return result


def document(*results: object) -> Json:
    """An Open-Meteo response holding ``results``."""
    return {"results": list(results), "generationtime_ms": 0.2}


def serve(respx_mock: respx.MockRouter, body: object, *, status: int = 200) -> respx.Route:
    """Answer the geocoding endpoint with a JSON ``body``."""
    return respx_mock.get(URL).respond(status, json=body)


def serve_fixture(respx_mock: respx.MockRouter, name: str, *, status: int = 200) -> respx.Route:
    """Answer the geocoding endpoint with a recorded response."""
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
        "open-meteo-geocoding",
        client=http_client,
        sleep=lambda _seconds: None,
        random_fn=lambda: 0.0,
    )


@pytest.fixture
def provider(upstream: UpstreamClient) -> OpenMeteoGeocodingProvider:
    return OpenMeteoGeocodingProvider(upstream)


# --------------------------------------------------------------------------- real responses


def test_denver_response_maps_to_candidates(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    serve_fixture(respx_mock, "omgeo-denver.json")

    results = provider.search("denver", limit=5)

    assert asdict(results[0]) == {
        "id": "geonames:5419384",
        "label": "Denver, Colorado, United States",
        "name": "Denver",
        "region": "Colorado",
        "country": "United States",
        "country_code": "US",
        "kind": "city",
        "lat": pytest.approx(39.73915),
        "lon": pytest.approx(-104.9847),
    }
    assert [candidate.id for candidate in results] == [
        "geonames:5419384",
        "geonames:5520110",
        "geonames:5186794",
        "geonames:4463523",
        "geonames:4853799",
    ]
    assert [candidate.label for candidate in results] == [
        "Denver, Colorado, United States",
        "Denver City, Texas, United States",
        "Denver, Pennsylvania, United States",
        "Denver, North Carolina, United States",
        "Denver, Iowa, United States",
    ]


def test_salt_lake_ranks_the_big_city_ahead_of_the_hawaiian_namesake(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    # The API lists Salt Lake (HI, 38,833) first; Salt Lake City (UT, 215,548) is fourth.
    serve_fixture(respx_mock, "omgeo-salt-lake.json")

    results = provider.search("salt lake", limit=5)

    assert [candidate.label for candidate in results] == [
        "Salt Lake City, Utah, United States",
        "Salt Lake, Hawaii, United States",
        "Salt Lake, South Australia, Australia",
        "Salt Lake, New Mexico, United States",
        "Salt Lake City, West Bengal, India",
    ]
    assert [candidate.country_code for candidate in results] == ["US", "US", "AU", "US", "IN"]
    assert results[0].id == "geonames:5780993"


def test_the_api_order_is_not_trusted_even_among_us_cities(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    # Massachusetts (154,341) comes after Illinois (114,394) in the recorded response.
    serve_fixture(respx_mock, "omgeo-springfield.json")

    results = provider.search("springfield", limit=10)

    assert [candidate.id for candidate in results] == [
        "geonames:4409896",
        "geonames:4951788",
        "geonames:4250542",
        "geonames:4525353",
        "geonames:4659557",
        "geonames:4402381",
        "geonames:5031678",
        "geonames:4309329",
        "geonames:4224162",
        "geonames:5440032",
    ]
    assert [candidate.label for candidate in results[:3]] == [
        "Springfield, Missouri, United States",
        "Springfield, Massachusetts, United States",
        "Springfield, Illinois, United States",
    ]
    assert {candidate.kind for candidate in results} == {"city"}


def test_the_cut_keeps_the_most_populous_places_not_the_first_listed(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    serve_fixture(respx_mock, "omgeo-springfield.json")

    results = provider.search("springfield", limit=3)

    assert [candidate.id for candidate in results] == [
        "geonames:4409896",
        "geonames:4951788",
        "geonames:4250542",
    ]


def test_an_airport_without_population_sorts_last_and_is_a_locality(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    serve_fixture(respx_mock, "omgeo-partial-den.json")

    results = provider.search("den", limit=5)

    assert [candidate.label for candidate in results] == [
        "Denver, Colorado, United States",
        "Denton, Texas, United States",
        "Cordova, Alabama, United States",
        "Dent, Minnesota, United States",
        "Denver International Airport, Colorado, United States",
    ]
    assert [candidate.kind for candidate in results] == ["city"] * 4 + ["locality"]


def test_features_that_are_not_populated_places_are_localities(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    serve_fixture(respx_mock, "omgeo-denver-co.json")

    results = provider.search("denver, co", limit=5)

    assert [candidate.id for candidate in results] == [
        "geonames:5419384",
        "geonames:5419400",
        "geonames:5417090",
        "geonames:7126209",
        "geonames:5576317",
    ]
    assert [candidate.kind for candidate in results] == ["city"] + ["locality"] * 4


def test_a_country_row_has_no_region_and_a_label_without_repeats(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    serve_fixture(respx_mock, "omgeo-united-states.json")

    results = provider.search("united states", limit=5)

    assert asdict(results[0]) == {
        "id": "geonames:6252001",
        "label": "United States",
        "name": "United States",
        "region": None,
        "country": "United States",
        "country_code": "US",
        "kind": "country",
        "lat": pytest.approx(39.76),
        "lon": pytest.approx(-98.5),
    }
    assert [candidate.kind for candidate in results] == [
        "country",
        "city",
        "locality",
        "locality",
        "locality",
    ]


def test_newark_response_is_returned_in_population_order_and_cut_to_the_limit(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    serve_fixture(respx_mock, "omgeo-newark.json")

    everything = provider.search("newark", limit=8)
    first_three = provider.search("newark", limit=3)

    assert [candidate.label for candidate in everything] == [
        "Newark, New Jersey, United States",
        "Newark, Ohio, United States",
        "Newark, California, United States",
        "Newark, Delaware, United States",
        "Newark, New York, United States",
        "Glenwood Landing, New York, United States",
        "Newark, Arkansas, United States",
        "Akron, Indiana, United States",
    ]
    assert first_three == everything[:3]


@pytest.mark.parametrize("fixture", ["omgeo-address.json", "omgeo-one-char.json"])
def test_a_response_without_results_means_no_candidates(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider, fixture: str
) -> None:
    serve_fixture(respx_mock, fixture)

    assert provider.search("1600 pennsylvania ave nw", limit=5) == ()


def test_an_empty_results_list_means_no_candidates(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    serve(respx_mock, {"results": []})

    assert provider.search("zzzzzz", limit=5) == ()


# --------------------------------------------------------------------------- the request


def test_request_carries_the_query_the_country_filter_and_twice_the_limit(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    route = serve_fixture(respx_mock, "omgeo-denver.json")

    provider.search("denver", limit=5)

    assert route.call_count == 1
    assert sent_params(route) == {
        "name": "denver",
        "count": "10",
        "language": "en",
        "format": "json",
        "countryCode": "US",
    }


@pytest.mark.parametrize(
    ("limit", "requested"),
    [(1, "2"), (2, "4"), (5, "10"), (9, "18"), (10, "20"), (11, "20"), (50, "20")],
)
def test_limit_is_doubled_for_deduplication_and_capped_at_twenty(
    respx_mock: respx.MockRouter,
    provider: OpenMeteoGeocodingProvider,
    limit: int,
    requested: str,
) -> None:
    route = serve(respx_mock, document())

    provider.search("denver", limit=limit)

    assert sent_params(route)["count"] == requested


def test_a_hostile_query_stays_inside_the_name_parameter(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    hostile = "denver&count=100&countryCode=XX#fragment=1 ?x=y"
    route = serve(respx_mock, document())

    provider.search(hostile, limit=1)

    request = route.calls.last.request
    assert sorted(key for key, _ in request.url.params.multi_items()) == [
        "count",
        "countryCode",
        "format",
        "language",
        "name",
    ]
    assert request.url.params["name"] == hostile
    assert request.url.params["count"] == "2"
    assert request.url.params["countryCode"] == "US"
    assert request.url.host == "geocoding-api.open-meteo.com"


def test_url_and_country_filter_are_configurable(
    respx_mock: respx.MockRouter, upstream: UpstreamClient
) -> None:
    route = respx_mock.get("https://geocoding.example.test/v9/search").respond(json=document())
    custom = OpenMeteoGeocodingProvider(
        upstream, url="https://geocoding.example.test/v9/search", country_code="CA"
    )

    custom.search("toronto", limit=3)

    assert sent_params(route) == {
        "name": "toronto",
        "count": "6",
        "language": "en",
        "format": "json",
        "countryCode": "CA",
    }


@pytest.mark.parametrize("limit", [0, -1, -50])
def test_a_limit_below_one_is_a_caller_bug_and_sends_nothing(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider, limit: int
) -> None:
    # No route is registered: a request would fail with an unmocked-request error, not ValueError.
    with pytest.raises(ValueError, match="limit"):
        provider.search("denver", limit=limit)
    assert respx_mock.calls.call_count == 0


# --------------------------------------------------------------------------- ranking, dedupe, cut


@pytest.mark.parametrize(
    ("populations", "order"),
    [
        pytest.param([10, 30, 20], [2, 3, 1], id="descending"),
        pytest.param([5, 5, 5], [1, 2, 3], id="ties-keep-the-api-order"),
        pytest.param([MISSING, 7, MISSING], [2, 1, 3], id="missing-counts-as-zero"),
        pytest.param([None, 7, 0], [2, 1, 3], id="null-and-zero-tie-at-zero"),
        pytest.param(["9000", 7, True], [2, 1, 3], id="text-and-booleans-count-as-zero"),
        pytest.param([-5, 7, -1], [2, 1, 3], id="negative-counts-as-zero"),
        pytest.param([1234, 1234.5, 1233.9], [2, 1, 3], id="fractions-compare-exactly"),
        pytest.param([3, 10**400, 4], [2, 3, 1], id="a-huge-integer-ranks-first"),
        pytest.param([[1], {"a": 1}, 1], [3, 1, 2], id="containers-count-as-zero"),
    ],
)
def test_candidates_are_ranked_by_population_with_unusable_values_as_zero(
    respx_mock: respx.MockRouter,
    provider: OpenMeteoGeocodingProvider,
    populations: list[object],
    order: list[int],
) -> None:
    serve(
        respx_mock,
        document(
            *[
                make_result(id=number, population=value)
                for number, value in enumerate(populations, 1)
            ]
        ),
    )

    results = provider.search("x", limit=10)

    assert [candidate.id for candidate in results] == [f"geonames:{number}" for number in order]


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_a_non_finite_population_counts_as_zero(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider, value: float
) -> None:
    # Python's json module parses the non-standard NaN/Infinity tokens; httpx refuses to encode
    # them, hence the raw body.
    body = json.dumps(
        document(
            make_result(id=1, population=value),
            make_result(id=2, population=5),
            make_result(id=3, population=value),
        )
    )
    respx_mock.get(URL).respond(
        200, content=body.encode(), headers={"content-type": "application/json"}
    )

    results = provider.search("x", limit=10)

    assert [candidate.id for candidate in results] == ["geonames:2", "geonames:1", "geonames:3"]


def test_the_more_populous_duplicate_wins(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    serve(
        respx_mock,
        document(
            make_result(id=1, name="Small", population=10),
            make_result(id=2, name="Other", population=50),
            make_result(id=1, name="Big", population=100),
        ),
    )

    results = provider.search("x", limit=10)

    assert [(candidate.id, candidate.name) for candidate in results] == [
        ("geonames:1", "Big"),
        ("geonames:2", "Other"),
    ]


def test_duplicates_are_removed_before_the_cut(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    serve(
        respx_mock,
        document(
            make_result(id=1, population=30),
            make_result(id=1, population=20),
            make_result(id=2, population=10),
            make_result(id=3, population=5),
        ),
    )

    results = provider.search("x", limit=2)

    assert [candidate.id for candidate in results] == ["geonames:1", "geonames:2"]


# --------------------------------------------------------------------------- skipped results

BAD_RESULTS = [
    pytest.param(make_result(name=MISSING), id="no-name"),
    pytest.param(make_result(name="  \u200b "), id="blank-name"),
    pytest.param(make_result(name=123), id="non-text-name"),
    pytest.param(make_result(id=MISSING), id="no-id"),
    pytest.param(make_result(id="5419384"), id="text-id"),
    pytest.param(make_result(id=0), id="zero-id"),
    pytest.param(make_result(id=-5), id="negative-id"),
    pytest.param(make_result(id=True), id="boolean-id"),
    pytest.param(make_result(id=1.5), id="fractional-id"),
    pytest.param(make_result(id=2**63), id="id-beyond-64-bits"),
    pytest.param(make_result(latitude=MISSING), id="no-latitude"),
    pytest.param(make_result(longitude=MISSING), id="no-longitude"),
    pytest.param(make_result(latitude="39.7"), id="text-latitude"),
    pytest.param(make_result(longitude=None), id="null-longitude"),
    pytest.param(make_result(latitude=True), id="boolean-latitude"),
    pytest.param(make_result(latitude=90.0001), id="latitude-above-90"),
    pytest.param(make_result(latitude=-90.0001), id="latitude-below-minus-90"),
    pytest.param(make_result(longitude=180.0001), id="longitude-above-180"),
    pytest.param(make_result(longitude=-180.0001), id="longitude-below-minus-180"),
    pytest.param(
        make_result(latitude=-104.9847, longitude=39.73915), id="latitude-and-longitude-swapped"
    ),
    pytest.param(make_result(latitude=10**400), id="integer-too-big-for-a-float"),
]


@pytest.mark.parametrize("bad", BAD_RESULTS)
def test_unusable_results_are_skipped_without_disturbing_their_neighbours(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider, bad: Json
) -> None:
    serve(respx_mock, document(make_result(id=1), bad, make_result(id=2)))

    results = provider.search("x", limit=10)

    assert [candidate.id for candidate in results] == ["geonames:1", "geonames:2"]


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_non_finite_coordinates_are_skipped(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider, value: float
) -> None:
    body = json.dumps(
        document(
            make_result(id=1, latitude=value),
            make_result(id=3, longitude=value),
            make_result(id=2),
        )
    )
    respx_mock.get(URL).respond(
        200, content=body.encode(), headers={"content-type": "application/json"}
    )

    results = provider.search("x", limit=10)

    assert [candidate.id for candidate in results] == ["geonames:2"]


@pytest.mark.parametrize("corner", [(-180.0, -90.0), (180.0, 90.0), (-180.0, 90.0), (0, 0)])
def test_the_extreme_valid_coordinates_are_accepted(
    respx_mock: respx.MockRouter,
    provider: OpenMeteoGeocodingProvider,
    corner: tuple[float, float],
) -> None:
    lon, lat = corner
    serve(respx_mock, document(make_result(latitude=lat, longitude=lon)))

    (result,) = provider.search("x", limit=1)

    assert (result.lon, result.lat) == corner


# --------------------------------------------------------------------------- labels and kinds

LABEL_CASES = [
    pytest.param({}, "Denver", "Denver, Colorado, United States", id="name-region-country"),
    pytest.param(
        {"name": "New York", "admin1": "New York"},
        "New York",
        "New York, United States",
        id="a-region-repeating-the-name-is-dropped",
    ),
    pytest.param(
        {"admin1": "DENVER"},
        "Denver",
        "Denver, United States",
        id="a-region-repeating-the-name-ignoring-case-is-dropped",
    ),
    pytest.param({"admin1": MISSING}, "Denver", "Denver, United States", id="no-region"),
    pytest.param({"country": MISSING}, "Denver", "Denver, Colorado", id="no-country"),
    pytest.param(
        {"admin1": MISSING, "country": MISSING}, "Denver", "Denver", id="name-and-nothing-else"
    ),
    pytest.param(
        {"name": "United States", "admin1": MISSING, "country": "United States"},
        "United States",
        "United States",
        id="a-country-repeating-the-name-is-dropped",
    ),
    pytest.param(
        {"name": "<script>alert(1)</script>"},
        "<script>alert(1)</script>",
        "<script>alert(1)</script>, Colorado, United States",
        id="markup-comes-back-verbatim",
    ),
    pytest.param(
        {"name": "Den\x00ver\u202e", "admin1": "Colo\u200brado", "country": "United\tStates"},
        "Denver",
        "Denver, Colorado, United States",
        id="control-characters-never-survive",
    ),
    pytest.param(
        {"name": "  Den   ver \n", "admin1": "\tColorado  "},
        "Den ver",
        "Den ver, Colorado, United States",
        id="whitespace-is-collapsed",
    ),
    pytest.param(
        {"name": "Z\u00fcrich", "admin1": "Z\u00fcrich", "country": "Schweiz"},
        "Z\u00fcrich",
        "Z\u00fcrich, Schweiz",
        id="accented-names",
    ),
    pytest.param(
        {"name": "\u6771\u4eac", "admin1": "\u6771\u4eac\u90fd", "country": "\u65e5\u672c"},
        "\u6771\u4eac",
        "\u6771\u4eac, \u6771\u4eac\u90fd, \u65e5\u672c",
        id="cjk-names",
    ),
    pytest.param(
        {"admin1": 5, "country": ["US"]},
        "Denver",
        "Denver",
        id="non-text-parts-are-ignored",
    ),
]


@pytest.mark.parametrize(("overrides", "name", "label"), LABEL_CASES)
def test_name_and_label_are_built_from_the_parts_that_exist(
    respx_mock: respx.MockRouter,
    provider: OpenMeteoGeocodingProvider,
    overrides: dict[str, object],
    name: str,
    label: str,
) -> None:
    serve(respx_mock, document(make_result(**overrides)))

    (result,) = provider.search("x", limit=1)

    assert (result.name, result.label) == (name, label)


def test_overlong_text_is_capped_at_two_hundred_characters(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    serve(respx_mock, document(make_result(name="x" * 300, admin1="y" * 300)))

    (result,) = provider.search("x", limit=1)

    assert result.name == "x" * 200
    assert result.region == "y" * 200
    assert result.label == "x" * 200


@pytest.mark.parametrize(
    ("overrides", "region", "country"),
    [
        pytest.param({}, "Colorado", "United States", id="both-present"),
        pytest.param({"admin1": MISSING}, None, "United States", id="no-region"),
        pytest.param({"admin1": "  "}, None, "United States", id="blank-region"),
        pytest.param({"country": MISSING}, "Colorado", None, id="no-country"),
        pytest.param({"admin1": None, "country": None}, None, None, id="nulls"),
        pytest.param({"admin1": " Colo\u200brado "}, "Colorado", "United States", id="cleaned"),
    ],
)
def test_region_and_country_are_none_when_absent_or_blank(
    respx_mock: respx.MockRouter,
    provider: OpenMeteoGeocodingProvider,
    overrides: dict[str, object],
    region: str | None,
    country: str | None,
) -> None:
    serve(respx_mock, document(make_result(**overrides)))

    (result,) = provider.search("x", limit=1)

    assert (result.region, result.country) == (region, country)


@pytest.mark.parametrize(
    ("feature_code", "kind"),
    [
        pytest.param("PPL", "city", id="PPL"),
        pytest.param("PPLA", "city", id="PPLA"),
        pytest.param("PPLA2", "city", id="PPLA2"),
        pytest.param("PPLC", "city", id="PPLC"),
        pytest.param("PPLX", "city", id="PPLX"),
        pytest.param("PPLH", "city", id="PPLH"),
        pytest.param("ADM1", "state", id="ADM1"),
        pytest.param("ADM2", "county", id="ADM2"),
        pytest.param("PCLI", "country", id="PCLI"),
        pytest.param("PCLD", "country", id="PCLD"),
        pytest.param("PCLH", "country", id="PCLH"),
        pytest.param("ADM1H", "locality", id="historical-ADM1"),
        pytest.param("ADM2H", "locality", id="historical-ADM2"),
        pytest.param("ADM3", "locality", id="ADM3"),
        pytest.param("AIRP", "locality", id="AIRP"),
        pytest.param("MT", "locality", id="MT"),
        pytest.param("PRK", "locality", id="PRK"),
        pytest.param("ppl", "locality", id="matching-is-case-sensitive"),
        pytest.param("", "locality", id="empty"),
        pytest.param(MISSING, "locality", id="no-feature-code"),
        pytest.param(None, "locality", id="null-feature-code"),
        pytest.param(5, "locality", id="numeric-feature-code"),
        pytest.param(["PPL"], "locality", id="list-feature-code"),
    ],
)
def test_kind_follows_the_geonames_feature_class(
    respx_mock: respx.MockRouter,
    provider: OpenMeteoGeocodingProvider,
    feature_code: object,
    kind: str,
) -> None:
    serve(respx_mock, document(make_result(feature_code=feature_code)))

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
    respx_mock: respx.MockRouter,
    provider: OpenMeteoGeocodingProvider,
    raw: object,
    code: str | None,
) -> None:
    serve(respx_mock, document(make_result(country_code=raw)))

    (result,) = provider.search("x", limit=1)

    assert result.country_code == code


# --------------------------------------------------------------------------- malformed documents

MALFORMED_DOCUMENTS = [
    pytest.param([], id="array"),
    pytest.param("results", id="string"),
    pytest.param(42, id="number"),
    pytest.param(None, id="null"),
    pytest.param({"results": None}, id="null-results"),
    pytest.param({"results": {}}, id="results-object"),
    pytest.param({"results": "none"}, id="results-string"),
    pytest.param({"results": 5}, id="results-number"),
    pytest.param({"results": [1]}, id="number-entry"),
    pytest.param({"results": [None]}, id="null-entry"),
    pytest.param({"results": ["result"]}, id="string-entry"),
    pytest.param({"results": [[]]}, id="array-entry"),
    pytest.param(document(make_result(id=1), 5), id="bad-entry-after-a-good-one"),
    pytest.param(document(5, make_result(id=1)), id="bad-entry-before-a-good-one"),
]


@pytest.mark.parametrize("body", MALFORMED_DOCUMENTS)
def test_a_document_of_the_wrong_shape_is_a_response_error(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider, body: object
) -> None:
    serve(respx_mock, body)

    with pytest.raises(ProviderResponseError) as excinfo:
        provider.search("x", limit=5)

    assert excinfo.value.provider == "open-meteo-geocoding"


def test_a_response_error_never_echoes_the_upstream_document(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    canary = "CANARY-9f1c-do-not-log"
    serve(respx_mock, {"results": canary})

    with pytest.raises(ProviderResponseError) as excinfo:
        provider.search("x", limit=5)

    assert canary not in str(excinfo.value)


# --------------------------------------------------------------------------- upstream failures


def test_a_recorded_http_400_is_a_rejection_that_names_the_reason(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    serve_fixture(respx_mock, "omgeo-no-name.json", status=400)

    with pytest.raises(ProviderRejectedError, match="No value found") as excinfo:
        provider.search("x", limit=5)

    assert excinfo.value.status == 400
    assert excinfo.value.provider == "open-meteo-geocoding"


def test_a_server_error_is_unavailable_after_the_retry_budget(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    route = respx_mock.get(URL).respond(503)

    with pytest.raises(ProviderUnavailableError, match="HTTP 503"):
        provider.search("x", limit=5)

    assert route.call_count == 3


def test_rate_limiting_surfaces_with_the_upstream_hint(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    route = respx_mock.get(URL).respond(429, headers={"Retry-After": "2"})

    with pytest.raises(ProviderRateLimitedError) as excinfo:
        provider.search("x", limit=5)

    assert excinfo.value.retry_after_s == pytest.approx(2.0)
    assert route.call_count == 2


def test_a_timeout_is_unavailable(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    respx_mock.get(URL).mock(side_effect=httpx.ConnectTimeout("timed out"))

    with pytest.raises(ProviderUnavailableError, match="timed out"):
        provider.search("x", limit=5)


def test_a_body_that_is_not_json_is_a_response_error(
    respx_mock: respx.MockRouter, provider: OpenMeteoGeocodingProvider
) -> None:
    respx_mock.get(URL).respond(200, text="<html>gateway hiccup</html>")

    with pytest.raises(ProviderResponseError, match="not valid JSON"):
        provider.search("x", limit=5)


# --------------------------------------------------------------------------- contract


def name_of(geocoder: GeocodingProvider) -> str:
    """Accepts anything that structurally is a geocoding provider (checked by mypy at the call)."""
    return geocoder.name


def test_provider_satisfies_the_geocoding_provider_protocol(
    provider: OpenMeteoGeocodingProvider,
) -> None:
    assert name_of(provider) == "open-meteo-geocoding"


# --------------------------------------------------------------------------- properties


class CannedClient(UpstreamClient):
    """An ``UpstreamClient`` that answers every GET with one fixed document, without any HTTP."""

    def __init__(self, http_client: httpx.Client, canned: object) -> None:
        super().__init__("open-meteo-geocoding", client=http_client)
        self.canned = canned

    @override
    def get_json(
        self,
        url: str,
        *,
        params: QueryParams | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> object:
        return self.canned


POPULATIONS = st.one_of(
    st.none(),
    st.integers(min_value=0, max_value=1_000),
    st.floats(min_value=0, max_value=1_000, allow_nan=False),
)


@given(
    populations=st.lists(POPULATIONS, min_size=1, max_size=12),
    limit=st.integers(min_value=1, max_value=12),
)
def test_results_are_ranked_by_population_with_ties_in_api_order(
    http_client: httpx.Client, populations: list[float | None], limit: int
) -> None:
    entries = [
        make_result(id=number, population=MISSING if value is None else value)
        for number, value in enumerate(populations, 1)
    ]
    provider = OpenMeteoGeocodingProvider(CannedClient(http_client, document(*entries)))

    results = provider.search("x", limit=limit)

    ranked = sorted(enumerate(populations, 1), key=lambda entry: -(entry[1] or 0))
    assert [candidate.id for candidate in results] == [
        f"geonames:{number}" for number, _ in ranked[:limit]
    ]


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
    st.sampled_from([[], {}, ["PPL"], {"a": 1}, [[]], "results"]),
)
JSON_VALUES = st.recursive(
    HOSTILE,
    lambda children: st.one_of(
        st.lists(children, max_size=3),
        st.dictionaries(st.sampled_from(["results", "id", "name", "a"]), children, max_size=3),
    ),
    max_leaves=6,
)


def mostly(valid: st.SearchStrategy[object]) -> st.SearchStrategy[object]:
    """``valid`` three times out of four, a hostile scalar or container otherwise."""
    return st.one_of(valid, valid, valid, HOSTILE)


FUZZ_RESULT = st.fixed_dictionaries(
    {
        "id": mostly(st.one_of(st.integers(min_value=1, max_value=2**63 - 1), NUMBERS)),
        "name": mostly(NASTY_TEXT),
        "latitude": mostly(st.one_of(st.floats(min_value=-90, max_value=90), NUMBERS)),
        "longitude": mostly(st.one_of(st.floats(min_value=-180, max_value=180), NUMBERS)),
    },
    optional={
        "admin1": mostly(NASTY_TEXT),
        "country": mostly(NASTY_TEXT),
        "country_code": mostly(st.sampled_from(["US", "us", "AU", "usa"])),
        "feature_code": mostly(st.sampled_from(["PPL", "PPLA2", "ADM1", "ADM2", "PCLI", "AIRP"])),
        "population": mostly(NUMBERS),
    },
)
FUZZ_DOCUMENT = st.one_of(
    JSON_VALUES,
    st.fixed_dictionaries({"results": st.lists(mostly(FUZZ_RESULT), max_size=6)}),
    st.fixed_dictionaries({"results": st.lists(FUZZ_RESULT, max_size=6)}),
)


def assert_clean_text(text: str) -> None:
    """Provider text reaches clients only cleaned and capped."""
    assert 0 < len(text) <= 200
    assert text == text.strip()
    for char in text:
        assert unicodedata.category(char) not in INVISIBLE_CATEGORIES
        assert char == " " or not char.isspace()


@given(body=FUZZ_DOCUMENT, limit=st.integers(min_value=1, max_value=12))
def test_any_upstream_document_yields_valid_candidates_or_a_response_error(
    http_client: httpx.Client, body: object, limit: int
) -> None:
    provider = OpenMeteoGeocodingProvider(CannedClient(http_client, body))

    try:
        results = provider.search("x", limit=limit)
    except ProviderResponseError:
        return

    assert len(results) <= limit
    assert len({candidate.id for candidate in results}) == len(results)
    for candidate in results:
        assert re.fullmatch(r"geonames:[1-9][0-9]{0,18}", candidate.id)
        assert candidate.kind in KINDS
        assert -90 <= candidate.lat <= 90
        assert -180 <= candidate.lon <= 180
        assert candidate.country_code is None or re.fullmatch(r"[A-Z]{2}", candidate.country_code)
        for text in (candidate.name, candidate.label):
            assert_clean_text(text)
        for optional in (candidate.region, candidate.country):
            if optional is not None:
                assert_clean_text(optional)
