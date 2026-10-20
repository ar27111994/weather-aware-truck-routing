"""The plan and heatmap routes are governed by the contract's rate rules.

``POST /plans`` is limited to 6 a minute and 60 a day, a heatmap read to 30 a minute and every
other read (a stored plan) falls under the default of 120 a minute. The other plan tests run with
a limiter that never refuses; here the real limiter (in memory, on a frozen clock) stands in front
of the real routes, so a route whose path stopped matching its rule fails these tests instead of
silently falling back to the default policy.
"""

from typing import Any

import pytest
import respx
from django.test import Client

import haulcast.api.ratelimit as ratelimit_middleware
from haulcast.services.ratelimit import InMemoryRateLimiter, RateLimitService
from tests.plans.support import (
    NEWARK_JERSEY_CITY,
    WeatherUpstream,
    benign,
    body,
    mock_routing,
    next_hour,
)
from tests.plans.test_create_plan import post
from tests.services.conftest import FakeClock

pytestmark = pytest.mark.django_db

PLANS_POLICY = '"minute";q=6;w=60, "day";q=60;w=86400'
HEATMAP_POLICY = '"minute";q=30;w=60'
DEFAULT_POLICY = '"minute";q=120;w=60'


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> FakeClock:
    """The real limiter on a frozen clock (it replaces the always-allow limiter of this package)."""
    frozen = FakeClock()
    service = RateLimitService(InMemoryRateLimiter(clock=frozen), InMemoryRateLimiter(clock=frozen))
    monkeypatch.setattr(ratelimit_middleware, "rate_limit_service", lambda: service)
    return frozen


@pytest.fixture
def stored(client: Client, upstream: respx.MockRouter) -> dict[str, Any]:
    """A short plan over benign weather, created before the limiter under test is installed."""
    mock_routing(upstream, NEWARK_JERSEY_CITY)
    WeatherUpstream(upstream, benign)
    plan: dict[str, Any] = post(client, body(NEWARK_JERSEY_CITY, next_hour(), interval=10)).json()
    return plan


def test_the_seventh_plan_request_in_a_minute_is_refused_and_ten_seconds_later_allowed(
    client: Client, upstream: respx.MockRouter, clock: FakeClock
) -> None:
    """Repeats of one request are answered from the store, so six cost the upstreams one."""
    mock_routing(upstream, NEWARK_JERSEY_CITY)
    WeatherUpstream(upstream, benign)
    payload = body(NEWARK_JERSEY_CITY, next_hour(), interval=10)

    responses = [post(client, payload) for _ in range(7)]
    clock.advance(10.0)  # 6 a minute refills one token every 10 seconds
    refilled = post(client, payload)

    assert [response.status_code for response in responses] == [201, 200, 200, 200, 200, 200, 429]
    assert responses[0]["RateLimit-Policy"] == PLANS_POLICY
    refused = responses[-1]
    assert refused.json()["code"] == "rate_limited"
    assert 1 <= int(refused["Retry-After"]) <= 10
    assert refilled.status_code == 200


def test_the_thirty_first_heatmap_read_in_a_minute_is_refused_while_plan_reads_are_not(
    client: Client, stored: dict[str, Any], clock: FakeClock
) -> None:
    plan_url = f"/api/v1/plans/{stored['plan_id']}"

    heatmaps = [client.get(f"{plan_url}/heatmap") for _ in range(31)]
    plan_read = client.get(plan_url)
    clock.advance(2.0)  # 30 a minute refills one token every 2 seconds
    refilled = client.get(f"{plan_url}/heatmap")

    assert [response.status_code for response in heatmaps] == [200] * 30 + [429]
    assert heatmaps[0]["RateLimit-Policy"] == HEATMAP_POLICY
    assert heatmaps[-1].json()["code"] == "rate_limited"
    assert 1 <= int(heatmaps[-1]["Retry-After"]) <= 2
    assert plan_read.status_code == 200
    assert plan_read["RateLimit-Policy"] == DEFAULT_POLICY
    assert refilled.status_code == 200
