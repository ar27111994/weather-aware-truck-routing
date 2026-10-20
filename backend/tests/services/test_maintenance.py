"""Behaviour of the maintenance use case: the cleanup it runs and the time it is allowed to take."""

from collections.abc import Callable

import pytest
from django.db import connection

from haulcast.services.maintenance import run_cleanup

pytestmark = pytest.mark.django_db


def test_cleanup_reports_the_rows_it_deleted_per_table() -> None:
    assert set(run_cleanup()) == {
        "geocode_cache",
        "route_cache",
        "weather_cache",
        "plan",
        "rate_limit_bucket",
        "single_flight_lease",
        "upstream_budget",
    }


def test_cleanup_may_run_longer_than_the_runtime_role_s_default_statement_budget() -> None:
    sent: list[str] = []

    def record(execute: Callable[..., object], statement: str, *rest: object) -> object:
        sent.append(statement)
        return execute(statement, *rest)

    with connection.execute_wrapper(record):
        run_cleanup()

    # The role default of 5 s would abort a large daily delete: the budget is raised for this
    # transaction only, before the function runs.
    raised = [index for index, text in enumerate(sent) if text.startswith("SET LOCAL")]
    cleanup = [index for index, text in enumerate(sent) if "cleanup_expired" in text]
    assert [sent[index] for index in raised] == ["SET LOCAL statement_timeout = '20s'"]
    assert raised[0] < cleanup[0]
