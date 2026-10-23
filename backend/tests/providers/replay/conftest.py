"""Shared fixtures of the replay tests: the recorded catalog and clients on the replay transport."""

import httpx
import pytest

from haulcast.providers.http import DEFAULT_POLICY, HttpPolicy, UpstreamClient, build_client
from haulcast.providers.replay.catalog import ReplayCatalog
from haulcast.providers.replay.transport import ReplayTransport
from tests.plans.support import FIXTURES


@pytest.fixture(scope="session")
def catalog() -> ReplayCatalog:
    """The recorded provider fixtures of the repository."""
    return ReplayCatalog(FIXTURES)


@pytest.fixture
def transport(catalog: ReplayCatalog) -> ReplayTransport:
    """A fresh replay transport over the recorded catalog."""
    return ReplayTransport(catalog)


def upstream(
    name: str,
    transport: httpx.BaseTransport | None,
    *,
    headers: dict[str, str] | None = None,
    policy: HttpPolicy = DEFAULT_POLICY,
) -> UpstreamClient:
    """The real upstream client of a provider, on ``transport`` instead of the network."""
    return UpstreamClient(
        name,
        client=build_client(headers=headers, policy=policy, transport=transport),
        policy=policy,
    )
