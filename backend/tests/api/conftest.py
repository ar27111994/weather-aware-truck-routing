"""Fixtures for the API tests: isolated limiter state and a client for the probe URLconf."""

from collections.abc import Iterator

import pytest
from django.test import Client
from pytest_django import Settings

from haulcast.services.ratelimit import rate_limit_service

PROBE_URLCONF = "tests.api.probe_urls"


@pytest.fixture(autouse=True)
def _isolated_limiter() -> Iterator[None]:
    """Every test starts with fresh in-process limiter state and leaves none behind."""
    rate_limit_service.cache_clear()
    yield
    rate_limit_service.cache_clear()


@pytest.fixture
def probe_client(settings: Settings) -> Client:
    """A client for the probe URLconf behind the request-level middleware.

    The rate limiter is left out (it needs the database): the tests that use this client are about
    the error taxonomy and the request guards, and run without database access.
    """
    settings.ROOT_URLCONF = PROBE_URLCONF
    settings.MIDDLEWARE = [
        entry for entry in settings.MIDDLEWARE if not entry.endswith("RateLimitMiddleware")
    ]
    return Client(raise_request_exception=False)
