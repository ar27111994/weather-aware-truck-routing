"""``GET /api/v1/geocode`` end to end: real chain, real cache table, recorded upstream responses."""

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from django.test import Client

import haulcast.api.ratelimit as ratelimit_middleware
from haulcast.services.container import geocoding_service
from haulcast.services.ratelimit import InMemoryRateLimiter, RateLimitService
from haulcast.store.models import GeocodeCache
from tests.services.conftest import FakeClock

PATH = "/api/v1/geocode"
PHOTON = "https://photon.komoot.io/api"
OPEN_METEO = "https://geocoding-api.open-meteo.com/v1/search"
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "providers" / "geocoding"
CACHE_CONTROL = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400"

pytestmark = pytest.mark.django_db


def recorded(name: str) -> dict[str, Any]:
    """A real upstream response recorded in ``tests/fixtures/providers/geocoding``."""
    document = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    assert isinstance(document, dict)
    return document


@pytest.fixture(autouse=True)
def _fresh_wiring() -> Iterator[None]:
    """The service (and its in-process cache and provider health) is rebuilt for every test."""
    geocoding_service.cache_clear()
    yield
    geocoding_service.cache_clear()


@pytest.fixture
def upstream() -> Iterator[respx.MockRouter]:
    """Intercept every outbound request: anything not routed explicitly fails the test."""
    with respx.mock(assert_all_called=False) as router:
        yield router


@pytest.fixture
def photon(upstream: respx.MockRouter) -> respx.Route:
    """Photon (asked when Open-Meteo has nothing or fails) answers with the recorded ``denver``."""
    return upstream.get(PHOTON).mock(
        return_value=httpx.Response(200, json=recorded("photon-denver.json"))
    )


@pytest.fixture
def open_meteo(upstream: respx.MockRouter) -> respx.Route:
    """Open-Meteo geocoding (asked first) answers with the recorded ``denver`` response."""
    return upstream.get(OPEN_METEO).mock(
        return_value=httpx.Response(200, json=recorded("omgeo-denver.json"))
    )


# --------------------------------------------------------------------------- the contract


@pytest.mark.usefixtures("open_meteo")
def test_a_search_returns_the_documented_shape(client: Client) -> None:
    response = client.get(PATH, {"q": "denver"})

    body = response.json()
    assert response.status_code == 200
    assert response["Content-Type"].startswith("application/json")
    assert set(body) == {"query", "results"}
    assert body["query"] == "denver"
    assert len(body["results"]) == 5
    assert body["results"][0] == {
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
    assert all(set(item) == set(body["results"][0]) for item in body["results"])


@pytest.mark.usefixtures("open_meteo")
def test_the_response_is_cacheable_by_browsers_and_the_cdn(client: Client) -> None:
    response = client.get(PATH, {"q": "denver"})

    assert response["Cache-Control"] == CACHE_CONTROL
    assert response["X-Content-Type-Options"] == "nosniff"
    assert response["RateLimit-Policy"] == '"minute";q=60;w=60'


@pytest.mark.usefixtures("open_meteo")
@pytest.mark.parametrize(("limit", "count"), [(1, 1), (2, 2), (8, 5)])
def test_limit_slices_the_candidates(client: Client, limit: int, count: int) -> None:
    params: dict[str, str | int] = {"q": "denver", "limit": limit}

    body = client.get(PATH, params).json()

    assert len(body["results"]) == count


def test_the_city_index_is_asked_for_us_places_and_the_application_identifies_itself(
    client: Client, open_meteo: respx.Route
) -> None:
    client.get(PATH, {"q": "denver"})

    request = open_meteo.calls.last.request
    assert request.url.params["name"] == "denver"
    assert request.url.params["countryCode"] == "US"
    assert request.headers["User-Agent"].startswith("Haulcast/")
    assert "github.com/ar27111994/weather-aware-truck-routing" in request.headers["User-Agent"]


def test_a_search_the_city_index_cannot_answer_goes_to_photon_with_the_us_bias(
    client: Client, upstream: respx.MockRouter, photon: respx.Route
) -> None:
    # The city index is a partial one: "nothing" from it sends the search on, so the US restriction
    # of that index never becomes a restriction of what can be found.
    upstream.get(OPEN_METEO).mock(
        return_value=httpx.Response(200, json=recorded("omgeo-address.json"))
    )

    body = client.get(PATH, {"q": "denver"}).json()

    request = photon.calls.last.request
    assert request.url.params["q"] == "denver"
    assert request.url.params["lat"] == "39.5"
    assert request.url.params["lon"] == "-98.35"
    assert request.headers["User-Agent"].startswith("Haulcast/")
    assert body["results"][0]["id"] == "osm:R1411339"


# --------------------------------------------------------------------------- caching


def test_a_repeated_search_is_served_from_the_cache(
    client: Client, open_meteo: respx.Route
) -> None:
    first = client.get(PATH, {"q": "denver"}).json()
    second = client.get(PATH, {"q": "denver", "limit": "3"}).json()

    assert open_meteo.call_count == 1
    assert second["results"] == first["results"][:3]
    assert GeocodeCache.objects.count() == 1


def test_case_and_spacing_do_not_defeat_the_cache(client: Client, open_meteo: respx.Route) -> None:
    for spelling in ("denver", "DENVER", "  Denver  ", "den\u200bver"):
        assert client.get(PATH, {"q": spelling}).status_code == 200

    assert open_meteo.call_count == 1


# --------------------------------------------------------------------------- fallback and failure


def test_when_the_city_index_is_down_photon_answers(
    client: Client, upstream: respx.MockRouter, photon: respx.Route
) -> None:
    open_meteo = upstream.get(OPEN_METEO).mock(
        return_value=httpx.Response(429, headers={"Retry-After": "30"}, json={"message": "slow"})
    )

    response = client.get(PATH, {"q": "denver"})

    body = response.json()
    assert response.status_code == 200
    assert open_meteo.call_count == 1
    assert photon.call_count == 1
    assert body["results"][0]["label"].startswith("Denver")
    assert body["results"][0]["country_code"] == "US"


def test_when_the_city_index_answers_garbage_photon_answers(
    client: Client, upstream: respx.MockRouter, photon: respx.Route
) -> None:
    upstream.get(OPEN_METEO).mock(
        return_value=httpx.Response(200, content=b"<html>not json</html>")
    )

    response = client.get(PATH, {"q": "denver"})

    assert response.status_code == 200
    assert photon.call_count == 1


def test_when_every_provider_fails_the_answer_is_a_503_problem_with_the_longest_retry_hint(
    client: Client, upstream: respx.MockRouter
) -> None:
    secret_text = "internal upstream stack trace " + "do-not-leak"
    upstream.get(PHOTON).mock(
        return_value=httpx.Response(503, headers={"Retry-After": "30"}, text=secret_text)
    )
    upstream.get(OPEN_METEO).mock(
        return_value=httpx.Response(503, headers={"Retry-After": "45"}, text=secret_text)
    )

    response = client.get(PATH, {"q": "denver"})

    body = response.json()
    assert response.status_code == 503
    assert response["Content-Type"] == "application/problem+json"
    assert response["Retry-After"] == "45"
    assert response["Cache-Control"] == "no-store"
    assert body["code"] == "geocoding_unavailable"
    assert body["detail"] == "Place search is temporarily unavailable."
    assert secret_text not in response.content.decode()
    assert GeocodeCache.objects.count() == 0


# --------------------------------------------------------------------------- validation


@pytest.mark.parametrize("params", [{}, {"limit": 3}], ids=["nothing", "limit-only"])
def test_the_query_is_required(client: Client, params: dict[str, int]) -> None:
    response = client.get(PATH, params)

    body = response.json()
    assert response.status_code == 422
    assert body["code"] == "validation_error"
    assert body["errors"][0]["loc"] == ["query", "q"]


@pytest.mark.parametrize("raw", ["", "a", "  a  ", "\x00\x01", "x" * 121, " " * 30])
def test_queries_outside_two_to_one_twenty_characters_are_refused(client: Client, raw: str) -> None:
    response = client.get(PATH, {"q": raw})

    body = response.json()
    assert response.status_code == 422
    assert body["errors"] == [
        {
            "loc": ["query", "q"],
            "msg": "q must be 2 to 120 characters long",
            "type": "string_length",
        }
    ]


def test_an_absurdly_long_query_is_refused_before_it_is_normalised(client: Client) -> None:
    response = client.get(PATH, {"q": "x" * 600})

    assert response.status_code == 422
    assert response.json()["errors"][0]["loc"] == ["query", "q"]


@pytest.mark.parametrize("limit", ["0", "9", "-1", "abc", "2.5", ""])
def test_the_limit_must_be_between_one_and_eight(client: Client, limit: str) -> None:
    response = client.get(PATH, {"q": "denver", "limit": limit})

    assert response.status_code == 422
    assert response.json()["errors"][0]["loc"] == ["query", "limit"]


# --------------------------------------------------------------------------- hostile input


def test_markup_in_a_label_is_returned_as_data_in_a_json_response(
    client: Client, upstream: respx.MockRouter
) -> None:
    entry = recorded("omgeo-denver.json")["results"][0]
    entry["name"] = '<img src=x onerror="alert(1)">'
    upstream.get(OPEN_METEO).mock(return_value=httpx.Response(200, json={"results": [entry]}))

    response = client.get(PATH, {"q": "<script>alert(1)</script>"})

    assert response.status_code == 200
    assert response["Content-Type"].startswith("application/json")
    assert response["X-Content-Type-Options"] == "nosniff"
    body = response.json()
    assert body["query"] == "<script>alert(1)</script>"
    assert body["results"][0]["name"] == '<img src=x onerror="alert(1)">'


@pytest.mark.parametrize(
    "raw", ["Zürich", "北京", "São Paulo", "\uff24\uff45\uff4e\uff56\uff45\uff52"]
)
def test_unicode_queries_reach_the_upstream_normalised(
    client: Client, open_meteo: respx.Route, raw: str
) -> None:
    response = client.get(PATH, {"q": raw})

    assert response.status_code == 200
    sent = open_meteo.calls.last.request.url.params["name"]
    assert sent == response.json()["query"]
    assert sent == sent.strip()


HOSTILE_QUERIES = [
    "http://169.254.169.254/latest/meta-data",
    "https://evil.example/",
    "//evil.example/%2e%2e/",
    "photon.komoot.io@evil.example",
    "denver\r\nHost: evil.example",
]


@pytest.mark.parametrize("hostile", HOSTILE_QUERIES)
def test_no_user_input_ever_chooses_where_the_server_connects(
    client: Client, upstream: respx.MockRouter, open_meteo: respx.Route, hostile: str
) -> None:
    client.get(PATH, {"q": hostile})

    assert open_meteo.call_count == 1
    hosts = {call.request.url.host for route in upstream.routes for call in route.calls}
    assert hosts == {"geocoding-api.open-meteo.com"}
    assert open_meteo.calls.last.request.url.path == "/v1/search"


@pytest.mark.parametrize("hostile", HOSTILE_QUERIES)
def test_nor_does_the_search_that_goes_on_to_photon(
    client: Client, upstream: respx.MockRouter, photon: respx.Route, hostile: str
) -> None:
    upstream.get(OPEN_METEO).mock(
        return_value=httpx.Response(200, json=recorded("omgeo-address.json"))
    )

    client.get(PATH, {"q": hostile})

    assert photon.call_count == 1
    hosts = {call.request.url.host for route in upstream.routes for call in route.calls}
    assert hosts == {"geocoding-api.open-meteo.com", "photon.komoot.io"}
    assert photon.calls.last.request.url.path == "/api"


# --------------------------------------------------------------------------- rate limiting


@pytest.mark.usefixtures("open_meteo")
def test_the_sixty_first_search_in_a_minute_is_refused_and_one_second_later_allowed(
    client: Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Frozen clock: 60 per minute refills one token per second, so wall time is irrelevant."""
    clock = FakeClock()
    service = RateLimitService(InMemoryRateLimiter(clock=clock), InMemoryRateLimiter(clock=clock))
    monkeypatch.setattr(ratelimit_middleware, "rate_limit_service", lambda: service)

    responses = [client.get(PATH, {"q": "denver"}) for _ in range(61)]
    clock.advance(1.0)
    refilled = client.get(PATH, {"q": "denver"})

    assert [response.status_code for response in responses] == [200] * 60 + [429]
    refused = responses[-1]
    assert refused.json()["code"] == "rate_limited"
    assert 1 <= int(refused["Retry-After"]) <= 2
    assert refilled.status_code == 200
