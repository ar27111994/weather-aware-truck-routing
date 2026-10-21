"""The rate-limit middleware: per-endpoint policies, IETF headers, 429 problems, client identity."""

import logging
import re
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

import pytest
from django.db import Error as DatabaseError
from django.test import Client
from pytest_django import Settings

import haulcast.api.ratelimit as ratelimit_middleware
from haulcast.services.client_ip import client_key
from haulcast.services.ratelimit import (
    InMemoryRateLimiter,
    RateDecision,
    RateLimitService,
    RateRule,
)
from haulcast.store.models import RateLimitBucket

if TYPE_CHECKING:
    from django.test.client import _MonkeyPatchedWSGIResponse

PLANS = "/api/v1/plans"
JSON = "application/json"
TEST_CLIENT_ADDRESS = "127.0.0.1"
"""The socket address of Django's test client, unless a request says otherwise."""

pytestmark = pytest.mark.django_db


def _post_plan(
    client: Client, headers: Mapping[str, str] | None = None, remote_addr: str | None = None
) -> int:
    """POST to the plans path; only the limiter's verdict (429 or not) matters to these tests.

    ``remote_addr`` sets the WSGI socket address of this one request.
    """
    address = TEST_CLIENT_ADDRESS if remote_addr is None else remote_addr
    return client.post(
        PLANS, data="{}", content_type=JSON, headers=headers, REMOTE_ADDR=address
    ).status_code


# --------------------------------------------------------------------------- headers


def test_an_allowed_request_reports_the_policy_and_the_remaining_quota(client: Client) -> None:
    response = client.get("/api/v1/health/ready")

    assert response["RateLimit-Policy"] == '"minute";q=120;w=60'
    assert re.fullmatch(r'"minute";r=119;t=\d+', response["RateLimit"])


@pytest.mark.parametrize("method", ["get", "head"])
def test_a_response_a_shared_cache_may_store_carries_no_per_client_quota(
    client: Client, method: str
) -> None:
    """R2-31: a CDN would replay this client's remaining quota to every other client."""
    response = getattr(client, method)("/api/v1/rules")

    assert response["Cache-Control"].startswith("public")
    assert response["RateLimit-Policy"] == '"minute";q=120;w=60'
    assert "RateLimit" not in response


def test_a_refusal_carries_the_quota_of_the_client_it_was_for(client: Client) -> None:
    for _ in range(6):
        _post_plan(client)

    response = client.post(PLANS, data="{}", content_type=JSON)

    assert response.status_code == 429
    assert re.fullmatch(r'"minute";r=0;t=\d+', response["RateLimit"])


def test_the_plans_endpoint_reports_both_of_its_buckets(client: Client) -> None:
    response = client.post(PLANS, data="{}", content_type=JSON)

    assert response["RateLimit-Policy"] == '"minute";q=6;w=60, "day";q=60;w=86400'
    assert re.fullmatch(r'"minute";r=5;t=\d+, "day";r=59;t=\d+', response["RateLimit"])


def _remaining(response: "_MonkeyPatchedWSGIResponse") -> int:
    """The ``r=`` value (tokens left) of the first bucket in the ``RateLimit`` header."""
    match = re.search(r"r=(\d+)", response["RateLimit"])
    assert match is not None
    return int(match.group(1))


def test_the_remaining_quota_counts_down(client: Client) -> None:
    remaining = [_remaining(client.get("/api/v1/health/ready")) for _ in range(3)]

    assert remaining == [119, 118, 117]


# --------------------------------------------------------------------------- refusals


def test_the_seventh_plan_request_in_a_minute_is_a_429_problem(client: Client) -> None:
    allowed = [_post_plan(client) for _ in range(6)]

    response = client.post(PLANS, data="{}", content_type=JSON)

    assert 429 not in allowed
    body = response.json()
    assert response.status_code == 429
    assert response["Content-Type"] == "application/problem+json"
    assert response["Cache-Control"] == "no-store"
    assert body["code"] == "rate_limited"
    assert body["detail"] == "Too many requests; slow down and retry after the indicated delay."
    assert body["request_id"] == response["X-Request-ID"]
    assert 1 <= int(response["Retry-After"]) <= 10
    assert response["RateLimit-Policy"] == '"minute";q=6;w=60'
    assert re.fullmatch(r'"minute";r=0;t=\d+', response["RateLimit"])


def test_a_refused_request_does_not_consume_a_token_of_the_other_bucket(client: Client) -> None:
    for _ in range(7):
        _post_plan(client)

    day_bucket = RateLimitBucket.objects.get(key__startswith="plans:day:")
    minute_bucket = RateLimitBucket.objects.get(key__startswith="plans:minute:")

    # Six requests were allowed: the refused seventh took nothing from either bucket.
    assert (day_bucket.tat - day_bucket.updated_at).total_seconds() == pytest.approx(
        6 * 1440, abs=2
    )
    assert (minute_bucket.tat - minute_bucket.updated_at).total_seconds() == pytest.approx(
        60, abs=2
    )


def test_the_daily_bucket_can_refuse_while_the_minute_bucket_has_room(
    client: Client, settings: Settings
) -> None:
    key = client_key("127.0.0.1", settings.HAULCAST_RATE_LIMIT_SALT)
    now = datetime.now(UTC)
    RateLimitBucket.objects.create(
        key=f"plans:day:{key}",
        tat=now + timedelta(seconds=86_000),
        last_allowed=True,
        updated_at=now,
        expires_at=now + timedelta(days=1),
    )

    response = client.post(PLANS, data="{}", content_type=JSON)

    assert response.status_code == 429
    assert response["RateLimit-Policy"] == '"day";q=60;w=86400'
    assert re.fullmatch(r'"day";r=0;t=\d+', response["RateLimit"])
    assert 1_000 <= int(response["Retry-After"]) <= 1_100
    assert not RateLimitBucket.objects.filter(key__startswith="plans:minute:").exists()


def test_each_endpoint_family_has_its_own_bucket(client: Client) -> None:
    for _ in range(6):
        _post_plan(client)

    assert _post_plan(client) == 429
    assert client.get("/api/v1/rules").status_code == 200
    assert client.get("/api/v1/health").status_code == 200


# --------------------------------------------------------------------------- client identity


def test_clients_are_told_apart_by_the_configured_platform_header(
    client: Client, settings: Settings
) -> None:
    settings.HAULCAST_CLIENT_IP_HEADER = "x-forwarded-for"

    for _ in range(6):
        _post_plan(client, {"X-Forwarded-For": "203.0.113.5"})

    assert _post_plan(client, {"X-Forwarded-For": "203.0.113.5"}) == 429
    assert _post_plan(client, {"X-Forwarded-For": "203.0.113.6"}) != 429


def test_a_spoofed_forwarded_chain_cannot_dodge_the_limit_when_the_header_is_trusted(
    client: Client, settings: Settings
) -> None:
    settings.HAULCAST_CLIENT_IP_HEADER = "x-forwarded-for"

    for index in range(6):
        chain = {"X-Forwarded-For": f"203.0.113.{index}, 198.51.100.{index}"}
        _post_plan(client, chain, remote_addr=f"192.0.2.{index}")

    # Every chain was ignored and the socket addresses are no identity behind the platform: all
    # seven requests drew on the one shared bucket of clients nobody could identify.
    spoofed = {"X-Forwarded-For": "203.0.113.99, 198.51.100.99"}
    assert _post_plan(client, spoofed, remote_addr="192.0.2.99") == 429


def test_the_socket_address_mints_no_buckets_when_the_platform_header_is_trusted(
    client: Client, settings: Settings
) -> None:
    settings.HAULCAST_CLIENT_IP_HEADER = "x-forwarded-for"

    verdicts = [_post_plan(client, remote_addr=f"203.0.113.{index}") for index in range(7)]

    assert verdicts[-1] == 429


def test_a_header_that_is_not_the_trusted_one_cannot_dodge_the_limit(
    client: Client, settings: Settings
) -> None:
    settings.HAULCAST_CLIENT_IP_HEADER = "x-real-ip"

    for index in range(6):
        _post_plan(
            client, {"X-Forwarded-For": f"203.0.113.{index}"}, remote_addr=f"203.0.113.{index}"
        )

    # Vercel's runtime copies x-forwarded-for into REMOTE_ADDR: neither is the configured header.
    last = {"X-Forwarded-For": "203.0.113.99"}
    assert _post_plan(client, last, remote_addr="203.0.113.99") == 429


def test_forwarding_headers_are_ignored_entirely_when_none_is_trusted(client: Client) -> None:
    for index in range(6):
        _post_plan(client, {"X-Forwarded-For": f"203.0.113.{index}"})

    assert _post_plan(client, {"X-Forwarded-For": "203.0.113.200"}) == 429


def test_raw_addresses_are_never_stored(client: Client, settings: Settings) -> None:
    settings.HAULCAST_CLIENT_IP_HEADER = "x-forwarded-for"
    _post_plan(client, {"X-Forwarded-For": "203.0.113.5"})

    keys = list(RateLimitBucket.objects.values_list("key", flat=True))

    assert keys
    assert not any("203.0.113.5" in key for key in keys)
    assert all(re.fullmatch(r"plans:(minute|day):[0-9a-f]{32}", key) for key in keys)


# --------------------------------------------------------------------------- degraded mode


class _UnreachableStore:
    """A primary limiter whose database cannot be reached."""

    def take(self, client_key: str, rule: RateRule) -> RateDecision:
        raise DatabaseError(f"the rate-limit store is down ({rule.scope}, {len(client_key)})")


def test_when_the_database_is_down_the_in_process_limiter_takes_over(
    client: Client, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    service = RateLimitService(_UnreachableStore(), InMemoryRateLimiter())
    monkeypatch.setattr(ratelimit_middleware, "rate_limit_service", lambda: service)

    with caplog.at_level(logging.WARNING, logger="haulcast.ratelimit"):
        codes = [_post_plan(client) for _ in range(7)]

    assert codes[-1] == 429
    assert 429 not in codes[:-1]
    assert "rate_limit_store_unavailable" in caplog.text
