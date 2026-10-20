"""``/api/v1/internal/maintenance``: the cron-triggered cleanup behind a Bearer secret."""

import hmac
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

import pytest
from django.test import Client
from pytest_django import Settings

from haulcast.store.models import (
    GeocodeCache,
    Plan,
    RateLimitBucket,
    RouteCache,
    UpstreamBudget,
    WeatherCache,
)

PATH = "/api/v1/internal/maintenance"
SECRET = "cron-secret-" + "x" * 24
TABLES = {
    "geocode_cache",
    "route_cache",
    "weather_cache",
    "plan",
    "rate_limit_bucket",
    "upstream_budget",
}

if TYPE_CHECKING:
    from django.test.client import _MonkeyPatchedWSGIResponse

pytestmark = pytest.mark.django_db


def _call(
    client: Client, method: str, authorization: str | None = None
) -> "_MonkeyPatchedWSGIResponse":
    headers = {} if authorization is None else {"Authorization": authorization}
    if method == "get":
        return client.get(PATH, headers=headers)
    return client.post(PATH, data="{}", content_type="application/json", headers=headers)


def _seed(label: str, when: datetime) -> None:
    """One row per table whose ``expires_at`` is ``when``; keys carry ``label``."""
    GeocodeCache.objects.create(key=f"g-{label}", payload=[], provider="p", expires_at=when)
    RouteCache.objects.create(key=f"r-{label}", payload={}, provider="p", expires_at=when)
    WeatherCache.objects.create(
        location_key=f"+0,+0-{label}",
        model="m",
        variables_hash="h",
        window_start=when,
        hours=1,
        payload={},
        expires_at=when,
    )
    Plan.objects.create(id=f"pln_{label}", request_hash="h", request={}, result={}, expires_at=when)
    RateLimitBucket.objects.create(
        key=f"b-{label}", tat=when, last_allowed=True, updated_at=when, expires_at=when
    )
    UpstreamBudget.objects.create(
        key=f"u-{label}", tat=when, last_allowed=True, updated_at=when, expires_at=when
    )


@pytest.fixture
def secret(settings: Settings) -> str:
    """Configure the cron secret for the test and return it."""
    settings.HAULCAST_CRON_SECRET = SECRET
    return SECRET


# --------------------------------------------------------------------------- hidden by default


@pytest.mark.parametrize("method", ["get", "post"])
def test_the_endpoint_is_a_plain_404_while_no_secret_is_configured(
    client: Client, method: str
) -> None:
    response = _call(client, method, f"Bearer {SECRET}")

    unknown = client.get("/api/v1/definitely-not-here").json()
    body = response.json()
    assert response.status_code == 404
    assert {**body, "request_id": ""} == {**unknown, "request_id": ""}


# --------------------------------------------------------------------------- authentication


@pytest.mark.usefixtures("secret")
@pytest.mark.parametrize("method", ["get", "post"])
@pytest.mark.parametrize(
    "authorization",
    [
        None,
        "",
        "Bearer",
        "Bearer ",
        "Bearer wrong",
        "Bearer " + SECRET + "x",
        "Bearer " + SECRET[:-1],
        "Basic " + SECRET,
        SECRET,
        "Token " + SECRET,
        "Bearer ü" + SECRET,
    ],
)
def test_anything_but_the_exact_bearer_secret_is_a_401_without_detail(
    client: Client, method: str, authorization: str | None
) -> None:
    response = _call(client, method, authorization)

    body = response.json()
    assert response.status_code == 401
    assert body["code"] == "unauthorized"
    assert "detail" not in body
    assert SECRET not in response.content.decode()


@pytest.mark.usefixtures("secret")
@pytest.mark.parametrize("method", ["get", "post"])
@pytest.mark.parametrize(
    "authorization",
    [f"Bearer {SECRET}", f"bearer {SECRET}", f"BEARER {SECRET}", f"Bearer   {SECRET}  "],
)
def test_the_bearer_secret_opens_the_endpoint_for_get_and_post(
    client: Client, method: str, authorization: str
) -> None:
    response = _call(client, method, authorization)

    assert response.status_code == 200
    assert response["Cache-Control"] == "no-store"
    body = response.json()
    assert set(body["deleted"]) == TABLES
    assert datetime.fromisoformat(body["ran_at"]).tzinfo is not None


@pytest.mark.usefixtures("secret")
def test_the_secret_is_compared_with_hmac_compare_digest(
    client: Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[bytes, bytes]] = []
    real = hmac.compare_digest

    def spy(left: bytes, right: bytes) -> bool:
        calls.append((left, right))
        return real(left, right)

    monkeypatch.setattr(hmac, "compare_digest", spy)

    _call(client, "get", "Bearer guess")
    _call(client, "get", f"Bearer {SECRET}")

    assert (b"guess", SECRET.encode()) in calls
    assert (SECRET.encode(), SECRET.encode()) in calls


# --------------------------------------------------------------------------- the cleanup itself


@pytest.mark.usefixtures("secret")
def test_expired_rows_are_deleted_from_every_table_and_live_rows_survive(client: Client) -> None:
    now = datetime.now(UTC)
    _seed("old", now - timedelta(days=1))
    _seed("new", now + timedelta(days=1))

    response = _call(client, "get", f"Bearer {SECRET}")

    assert response.status_code == 200
    assert response.json()["deleted"] == dict.fromkeys(TABLES, 1)
    assert GeocodeCache.objects.filter(key="g-new").exists()
    assert not GeocodeCache.objects.filter(key="g-old").exists()
    assert Plan.objects.filter(id="pln_new").exists()
    assert not Plan.objects.filter(id="pln_old").exists()
    assert WeatherCache.objects.filter(location_key="+0,+0-new").exists()
    assert not WeatherCache.objects.filter(location_key="+0,+0-old").exists()
    assert UpstreamBudget.objects.filter(key="u-new").exists()
    assert RouteCache.objects.filter(key="r-new").exists()
    assert RateLimitBucket.objects.filter(key="b-new").exists()


@pytest.mark.usefixtures("secret")
def test_a_clean_database_reports_zero_deletions_everywhere(client: Client) -> None:
    response = _call(client, "post", f"Bearer {SECRET}")

    assert response.json()["deleted"] == dict.fromkeys(TABLES, 0)


@pytest.mark.usefixtures("secret")
def test_a_rejected_call_deletes_nothing(client: Client) -> None:
    _seed("old", datetime.now(UTC) - timedelta(days=1))

    assert _call(client, "get", "Bearer wrong").status_code == 401

    assert Plan.objects.filter(id="pln_old").exists()
