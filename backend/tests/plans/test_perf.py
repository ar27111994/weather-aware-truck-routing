"""Performance budgets of the plan API (N1: a cached plan answers in at most 400 ms).

Wall-clock assertions never run under coverage tracing: the default run deselects them and CI runs
``uv run pytest -m perf -rP``. Each test prints its measurements for the CI log.
"""

import time
from collections.abc import Callable
from datetime import timedelta
from typing import Any

import pytest
import respx
from django.test import Client

from tests.plans.support import SLC_DENVER, WeatherUpstream, body, mock_routing, next_hour
from tests.plans.test_create_plan import post

pytestmark = [pytest.mark.perf, pytest.mark.django_db]

BUDGET_S = 0.4
REPEATS = 5


def best_of(call: Callable[[int], Any]) -> float:
    """The fastest of ``REPEATS`` runs (least disturbed by a busy machine), in seconds."""
    timings = []
    for attempt in range(REPEATS):
        start = time.perf_counter()
        call(attempt)
        timings.append(time.perf_counter() - start)
    return min(timings)


def test_a_cached_plan_request_is_served_within_the_budget(
    client: Client, upstream: respx.MockRouter
) -> None:
    mock_routing(upstream, SLC_DENVER)
    WeatherUpstream(upstream)
    departure = next_hour()
    start = time.perf_counter()
    assert post(client, body(SLC_DENVER, departure)).status_code == 201
    cold = time.perf_counter() - start

    repeated = best_of(lambda _: post(client, body(SLC_DENVER, departure)))
    warm = best_of(
        lambda attempt: post(client, body(SLC_DENVER, departure + timedelta(minutes=attempt + 1)))
    )

    print(  # noqa: T201 - measurements go to the CI log (pytest -rP)
        f"plan latency ms: cold={cold * 1000:.0f} warm-caches={warm * 1000:.0f} "
        f"identical-request={repeated * 1000:.0f} (budget {BUDGET_S * 1000:.0f})"
    )
    assert repeated < BUDGET_S, "an identical request is answered from the stored plan"
    assert warm < BUDGET_S, "a new plan over cached routes and forecasts"
