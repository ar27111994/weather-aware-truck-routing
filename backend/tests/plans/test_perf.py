"""Performance budgets of the plan API (N1: plan p95 <= 8 s cold, <= 400 ms cached).

Wall-clock assertions never run under coverage tracing: the default run deselects them and CI runs
``uv run pytest -m perf -rP``. Each test prints its measurements for the CI log.

Three situations are measured, all with real adapters over recorded provider answers:

* *cold*: nothing cached (route, forecast and plan are all computed);
* *cached*: the same request again, answered from the stored plan (the N1 "cached" budget);
* *warm caches*: a new plan (another departure minute) over cached routes and forecasts, which
  still computes geometry, risk and the document: a regression guard, not a contract.
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

COLD_BUDGET_S = 8.0
CACHED_BUDGET_S = 0.4
WARM_BUDGET_S = 2.0
REPEATS = 5


def best_of(call: Callable[[int], Any]) -> float:
    """The fastest of ``REPEATS`` runs (least disturbed by a busy machine), in seconds."""
    timings = []
    for attempt in range(REPEATS):
        start = time.perf_counter()
        call(attempt)
        timings.append(time.perf_counter() - start)
    return min(timings)


def test_plan_latency_stays_within_the_budgets(client: Client, upstream: respx.MockRouter) -> None:
    mock_routing(upstream, SLC_DENVER)
    WeatherUpstream(upstream)
    departure = next_hour()
    start = time.perf_counter()
    assert post(client, body(SLC_DENVER, departure)).status_code == 201
    cold = time.perf_counter() - start

    cached = best_of(lambda _: post(client, body(SLC_DENVER, departure)))
    warm = best_of(
        lambda attempt: post(client, body(SLC_DENVER, departure + timedelta(minutes=attempt + 1)))
    )

    print(  # noqa: T201 - measurements go to the CI log (pytest -rP)
        f"plan latency ms: cold={cold * 1000:.0f} (budget {COLD_BUDGET_S * 1000:.0f}) "
        f"cached={cached * 1000:.0f} (budget {CACHED_BUDGET_S * 1000:.0f}) "
        f"warm-caches={warm * 1000:.0f} (guard {WARM_BUDGET_S * 1000:.0f})"
    )
    assert cold < COLD_BUDGET_S
    assert cached < CACHED_BUDGET_S, "an identical request is answered from the stored plan"
    assert warm < WARM_BUDGET_S, "a new plan over cached routes and forecasts"
