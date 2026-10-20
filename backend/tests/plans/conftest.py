"""Fixtures of the plan tests: fresh wiring for every test, a strict upstream, no rate limits."""

from collections.abc import Iterator

import pytest
import respx

import haulcast.api.ratelimit as ratelimit_middleware
from haulcast.services import container
from haulcast.services.ratelimit import BucketStatus, RateDecision, RateLimitService, RateRule

ACCESSORS = (
    container.routing_chain,
    container.routing_service,
    container.weather_service,
    container.plan_service,
    container.heatmap_service,
)


class AlwaysAllow:
    """A limiter that never refuses: the limits themselves are tested in ``tests/api``."""

    def take(self, client_key: str, rule: RateRule) -> RateDecision:  # noqa: ARG002 - protocol
        """Allow the request, reporting a full bucket per policy."""
        return RateDecision(
            allowed=True,
            retry_after_s=0.0,
            statuses=tuple(BucketStatus(policy, policy.limit, 0.0) for policy in rule.policies),
        )


@pytest.fixture(autouse=True)
def _fresh_wiring(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Rebuild the services of every test, with no pause between routing calls (no sleeping)."""
    monkeypatch.setattr(container, "ROUTING_MIN_INTERVAL_S", 0.0)
    for accessor in ACCESSORS:
        accessor.cache_clear()
    yield
    for accessor in ACCESSORS:
        accessor.cache_clear()


@pytest.fixture(autouse=True)
def _no_rate_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    permissive = RateLimitService(AlwaysAllow(), AlwaysAllow())
    monkeypatch.setattr(ratelimit_middleware, "rate_limit_service", lambda: permissive)


@pytest.fixture
def upstream() -> Iterator[respx.MockRouter]:
    """Intercept every outbound request: anything not routed explicitly fails the test."""
    with respx.mock(assert_all_called=False) as router:
        yield router
