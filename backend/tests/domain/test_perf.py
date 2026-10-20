"""Performance budgets (QUALITY-GATES section 2), excluded from the default run.

Run them without coverage tracing: ``uv run pytest -m perf`` (CI has a dedicated step). Each
budget is checked against the best of a few repetitions, the standard way to time code without
counting scheduler noise from a busy machine.
"""

import math
import sys
import time
from collections.abc import Callable

import pytest

from haulcast.domain import (
    RoutePath,
    WeatherSample,
    assess,
    build_path,
    plan_checkpoints,
)
from tests.domain.support import DEFAULT_TIME, RULES, weather

pytestmark = pytest.mark.perf

REPEATS = 5
ASSESSMENTS = 10_000
ASSESS_BUDGET_S = 0.200
PATH_POINTS = 20_000
PATH_LENGTH_MI = 3_000.0
CHECKPOINT_BUDGET_S = 0.100


def report(line: str) -> None:
    """Show a measurement in the run log (``pytest -m perf -rP`` prints passing tests' output)."""
    sys.stdout.write(f"{line}\n")


def best_time(action: Callable[[], object]) -> float:
    """Return the fastest wall-clock time of ``REPEATS`` runs of ``action``, in seconds."""
    timings = []
    for _ in range(REPEATS):
        start = time.perf_counter()
        action()
        timings.append(time.perf_counter() - start)
    return min(timings)


def varied_samples(count: int) -> list[WeatherSample]:
    """Samples spread over every band of every factor, so every code path is timed."""
    return [
        weather(
            wind=(i * 7.3) % 70.0,
            gust=(i * 11.1) % 90.0,
            rain=(i * 0.037) % 1.6,
            snow=(i * 0.091) % 4.5,
        )
        for i in range(count)
    ]


def cross_country_path() -> RoutePath:
    """A 20,000-point polyline from the Pacific to the Atlantic, rescaled to 3,000 mi."""
    coords = [
        (-122.4 + 48.4 * i / (PATH_POINTS - 1), 38.0 + 3.0 * math.sin(i / 500.0))
        for i in range(PATH_POINTS)
    ]
    cum_s = [i * 2.4 for i in range(PATH_POINTS)]
    return build_path(coords, cum_s, PATH_LENGTH_MI)


def test_ten_thousand_assessments_fit_the_budget() -> None:
    samples = varied_samples(ASSESSMENTS)
    loads = [(i * 4_001) % 80_001 for i in range(ASSESSMENTS)]

    elapsed = best_time(
        lambda: [assess(sample, load, RULES) for sample, load in zip(samples, loads, strict=True)]
    )

    report(f"{ASSESSMENTS:,} assess() calls: best {elapsed * 1000:.1f} ms (budget 200 ms)")
    assert elapsed < ASSESS_BUDGET_S, f"{ASSESSMENTS} assessments took {elapsed * 1000:.1f} ms"


def test_planning_checkpoints_on_a_long_dense_path_fits_the_budget() -> None:
    path = cross_country_path()

    elapsed = best_time(lambda: plan_checkpoints(path, 10, DEFAULT_TIME))

    checkpoints = plan_checkpoints(path, 10, DEFAULT_TIME)
    report(
        f"plan_checkpoints, {PATH_POINTS:,} points / {PATH_LENGTH_MI:,.0f} mi / "
        f"{len(checkpoints)} checkpoints: best {elapsed * 1000:.2f} ms (budget 100 ms)"
    )
    assert len(checkpoints) == 301
    assert elapsed < CHECKPOINT_BUDGET_S, f"plan_checkpoints took {elapsed * 1000:.2f} ms"
