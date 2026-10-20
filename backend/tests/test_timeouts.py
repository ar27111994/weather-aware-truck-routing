"""The time budgets add up: a request ends inside the function's maxDuration, however things fail.

``haulcast.config.timeouts`` holds every budget, ``docs/BACKEND.md`` ("Time budgets") adds them up
in a table, and ``vercel.json`` holds the platform's ``maxDuration``. These tests pin the three
together: change a budget and the arithmetic, the document and the platform setting have to change
with it (R2-02, R2-03). A function killed at ``maxDuration`` answers with the platform's non-problem
504 and skips every degraded mode the application has.
"""

import json
import re
from pathlib import Path

import pytest

from haulcast.config import timeouts
from haulcast.providers.http import DEFAULT_POLICY
from haulcast.providers.routing.diversity import DEFAULT_DIVERSITY
from haulcast.services.container import GEOCODING_HTTP_POLICY, ROUTING_HTTP_POLICY

ROOT = Path(__file__).resolve().parents[2]
BACKEND_DOC = (ROOT / "docs" / "BACKEND.md").read_text(encoding="utf-8")
HOBBY_MAX_DURATION_S = 60
"""The longest ``maxDuration`` the Hobby plan allows (``scripts/check_vercel_config.py``)."""


def max_duration_s() -> float:
    config = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
    return float(config["functions"]["api/index.py"]["maxDuration"])


def budgets() -> dict[str, float]:
    """Every budget constant of ``config.timeouts``: the public names ending in ``_S``."""
    return {
        name: float(value)
        for name, value in vars(timeouts).items()
        if name.endswith("_S") and name.isupper() and isinstance(value, int | float)
    }


def documented(name: str) -> list[float]:
    """The seconds in every table row of BACKEND.md whose cell holds exactly `name`."""
    pattern = re.compile(rf"\|\s*`{name}`\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|")
    return [float(found.group(1)) for found in pattern.finditer(BACKEND_DOC)]


def documented_total(label: str) -> float:
    """The bold seconds of the row of BACKEND.md labelled ``label``."""
    pattern = re.compile(
        rf"\|\s*{re.escape(label)}\s*\|[^|]*\|\s*\*\*([0-9]+(?:\.[0-9]+)?)\*\*\s*\|"
    )
    found = pattern.search(BACKEND_DOC)
    assert found is not None, f"BACKEND.md has no row labelled {label!r}"
    return float(found.group(1))


# --------------------------------------------------------------------------- the pinned values


def test_the_budgets_are_the_ones_that_were_decided() -> None:
    assert budgets() == {
        "DB_CONNECT_TIMEOUT_S": 3,
        "DB_MIGRATION_CONNECT_TIMEOUT_S": 5,
        "DB_STATEMENT_TIMEOUT_S": 5,
        "DB_IDLE_IN_TRANSACTION_TIMEOUT_S": 10,
        "DB_MAINTENANCE_STATEMENT_TIMEOUT_S": 20,
        "FLIGHT_LEASE_S": 30,
        "FLIGHT_WAIT_S": 25,
        "PLAN_BUDGET_S": 25,
        "HEATMAP_BUDGET_S": 25,
        "GEOCODE_BUDGET_S": 3.5,
        "GEOCODE_ATTEMPT_S": 2,
        "FUNCTION_HEADROOM_S": 2,
    }


def test_every_budget_is_documented_with_its_value() -> None:
    for name, seconds in budgets().items():
        rows = documented(name)
        assert rows, f"BACKEND.md (Time budgets) never mentions {name}"
        assert set(rows) == {seconds}, f"BACKEND.md gives {name} as {rows}, the code says {seconds}"


def test_the_documented_worst_case_and_maximum_duration_are_the_code_and_the_platform() -> None:
    assert documented_total("Worst case of the deadlines") == timeouts.worst_case_request_s()
    assert documented_total("`maxDuration` in `vercel.json`") == max_duration_s()


# --------------------------------------------------------------------------- the arithmetic


def test_the_worst_case_is_the_connection_two_statements_and_the_request_deadline() -> None:
    assert timeouts.worst_case_request_s() == 3 + 5 + 25 + 5


def test_the_function_outlives_the_worst_case_by_at_least_the_headroom() -> None:
    assert max_duration_s() >= timeouts.worst_case_request_s() + timeouts.FUNCTION_HEADROOM_S
    assert max_duration_s() <= HOBBY_MAX_DURATION_S


@pytest.mark.parametrize(
    ("name", "work_s"),
    [
        pytest.param("a search", timeouts.GEOCODE_BUDGET_S, id="geocode"),
        pytest.param("a heatmap", timeouts.HEATMAP_BUDGET_S, id="heatmap"),
        pytest.param("the cleanup", timeouts.DB_MAINTENANCE_STATEMENT_TIMEOUT_S, id="maintenance"),
    ],
)
def test_the_other_requests_fit_inside_the_function_too(name: str, work_s: float) -> None:
    total = timeouts.DB_CONNECT_TIMEOUT_S + work_s + timeouts.DB_STATEMENT_TIMEOUT_S
    assert total + timeouts.FUNCTION_HEADROOM_S <= max_duration_s(), name


# --------------------------------------------------------------------------- how the layers relate


def test_the_plan_budget_is_the_contracts_twenty_five_seconds() -> None:
    assert timeouts.PLAN_BUDGET_S == 25  # API-CONTRACT: the whole plan request budget
    assert timeouts.HEATMAP_BUDGET_S <= timeouts.PLAN_BUDGET_S


def test_a_healthy_leader_never_loses_its_lease_and_no_wait_outlasts_the_request() -> None:
    longest_work = max(timeouts.PLAN_BUDGET_S, timeouts.HEATMAP_BUDGET_S)
    assert longest_work < timeouts.FLIGHT_LEASE_S
    assert timeouts.FLIGHT_WAIT_S <= timeouts.PLAN_BUDGET_S


def test_a_geocoding_search_always_leaves_the_second_provider_a_real_attempt() -> None:
    assert timeouts.GEOCODE_ATTEMPT_S < timeouts.GEOCODE_BUDGET_S < 2 * timeouts.GEOCODE_ATTEMPT_S
    assert timeouts.GEOCODE_BUDGET_S - timeouts.GEOCODE_ATTEMPT_S >= 1.0


def test_the_database_times_are_ordered_and_whole_seconds_where_libpq_needs_them() -> None:
    assert timeouts.DB_STATEMENT_TIMEOUT_S < timeouts.DB_IDLE_IN_TRANSACTION_TIMEOUT_S
    assert timeouts.DB_STATEMENT_TIMEOUT_S < timeouts.DB_MAINTENANCE_STATEMENT_TIMEOUT_S
    assert isinstance(timeouts.DB_CONNECT_TIMEOUT_S, int)  # libpq's connect_timeout is integer
    assert isinstance(timeouts.DB_MIGRATION_CONNECT_TIMEOUT_S, int)


# --------------------------------------------------------------------------- the provider policies


def test_every_geocoding_provider_gets_one_attempt_bounded_by_the_attempt_budget() -> None:
    assert GEOCODING_HTTP_POLICY.max_retries == 0
    assert GEOCODING_HTTP_POLICY.rate_limit_retries == 0
    assert GEOCODING_HTTP_POLICY.attempt_deadline_s == timeouts.GEOCODE_ATTEMPT_S


def test_no_single_provider_attempt_can_outlast_a_request() -> None:
    for policy in (DEFAULT_POLICY, ROUTING_HTTP_POLICY):
        assert policy.attempt_deadline_s <= timeouts.PLAN_BUDGET_S


def test_the_forced_diversity_stage_fits_inside_the_plan_budget() -> None:
    assert DEFAULT_DIVERSITY.stage_budget_s == 10.0  # D-17: the routing stage is at most 10 s
    assert DEFAULT_DIVERSITY.stage_budget_s < timeouts.PLAN_BUDGET_S
