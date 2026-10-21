"""``GET /api/v1/plans/{plan_id}`` and ``/heatmap``: strong ETags, conditional requests, 404s."""

import re
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
import respx
from django.test import Client

from haulcast.store.models import Plan
from tests.plans.support import (
    NEWARK_JERSEY_CITY,
    WeatherUpstream,
    benign,
    body,
    mock_routing,
    next_hour,
)
from tests.plans.test_create_plan import post

pytestmark = pytest.mark.django_db

CACHE_CONTROL = "public, max-age=300, s-maxage=3600"


@pytest.fixture
def stored(client: Client, upstream: respx.MockRouter) -> dict[str, Any]:
    """A short plan over benign weather, as ``POST /plans`` returned it."""
    mock_routing(upstream, NEWARK_JERSEY_CITY)
    WeatherUpstream(upstream, benign)
    plan: dict[str, Any] = post(client, body(NEWARK_JERSEY_CITY, next_hour(), interval=10)).json()
    return plan


@pytest.fixture(params=["", "/heatmap"], ids=["plan", "heatmap"])
def url(request: pytest.FixtureRequest, stored: dict[str, Any]) -> str:
    return f"/api/v1/plans/{stored['plan_id']}{request.param}"


def test_the_document_is_served_with_a_strong_etag_and_the_cache_headers(
    client: Client, url: str
) -> None:
    response = client.get(url)

    assert response.status_code == 200
    assert response["Content-Type"] == "application/json"
    assert response["Cache-Control"] == CACHE_CONTROL
    assert re.fullmatch(r'"[0-9a-f]{32}"', response["ETag"])
    assert "X-Request-ID" not in response, "a shared cache would replay it (R2-31)"
    assert response["RateLimit-Policy"]
    assert "RateLimit" not in response


def test_the_etag_is_the_same_on_every_request(client: Client, url: str) -> None:
    assert client.get(url)["ETag"] == client.get(url)["ETag"]


def test_a_matching_if_none_match_is_a_304_without_a_body(client: Client, url: str) -> None:
    etag = client.get(url)["ETag"]

    response = client.get(url, headers={"If-None-Match": etag})

    assert response.status_code == 304
    assert response.content == b""
    assert response["ETag"] == etag
    assert response["Cache-Control"] == CACHE_CONTROL


def test_a_list_or_wildcard_if_none_match_also_revalidates(client: Client, url: str) -> None:
    etag = client.get(url)["ETag"]

    assert client.get(url, headers={"If-None-Match": f'"other", {etag}'}).status_code == 304
    assert client.get(url, headers={"If-None-Match": "*"}).status_code == 304


def test_a_different_etag_gets_the_full_document(client: Client, url: str) -> None:
    response = client.get(url, headers={"If-None-Match": '"0123456789abcdef0123456789abcdef"'})

    assert response.status_code == 200
    assert response.content


def test_get_returns_exactly_the_plan_that_post_returned(
    client: Client, stored: dict[str, Any]
) -> None:
    assert client.get(f"/api/v1/plans/{stored['plan_id']}").json() == stored


@pytest.mark.parametrize(
    ("plan_id", "code"),
    [
        ("pln_" + "0" * 26, "plan_not_found"),
        ("nope", "plan_not_found"),
        ("pln_", "plan_not_found"),
        ("PLN_" + "0" * 26, "plan_not_found"),
        ("pln_%2e%2e%2f", "not_found"),
    ],
    ids=["unknown", "malformed", "prefix-only", "wrong-case", "encoded-slash-never-routes"],
)
def test_an_unknown_plan_is_a_404_problem(client: Client, plan_id: str, code: str) -> None:
    response = client.get(f"/api/v1/plans/{plan_id}")

    problem = response.json()
    assert response.status_code == 404
    assert response["Content-Type"] == "application/problem+json"
    assert response["Cache-Control"] == "no-store"
    assert problem["code"] == code
    assert problem["status"] == 404
    assert problem["request_id"]


def test_an_expired_plan_is_a_404_problem(client: Client, stored: dict[str, Any]) -> None:
    url = f"/api/v1/plans/{stored['plan_id']}"
    assert client.get(url).status_code == 200
    Plan.objects.filter(id=stored["plan_id"]).update(
        expires_at=datetime.now(UTC) - timedelta(seconds=1)
    )

    response = client.get(url)

    assert response.status_code == 404
    assert response.json()["code"] == "plan_not_found"
