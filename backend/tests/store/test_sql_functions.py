"""Behaviour of the SQL functions that implement atomic GCRA buckets and the expired-row cleanup.

They are exercised through the *runtime* role, the way the application calls them.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest
from psycopg import errors, sql

from tests.dbtools import Connection


@dataclass(frozen=True)
class Shape:
    """The parameters of one bucket: ``rate`` per ``period``, holding ``burst`` tokens."""

    rate: int
    period: str
    burst: int


THREE_PER_HOUR = Shape(3, "1 hour", 3)
TEN_PER_HOUR = Shape(10, "1 hour", 10)
TWO_PER_HOUR = Shape(2, "1 hour", 2)


def _take(
    connection: Connection, function: str, key: str, shape: Shape, cost: int = 1
) -> tuple[bool, int, int, int]:
    """Call ``app.<function>``: ``(allowed, retry_after_ms, remaining, reset_after_ms)``."""
    statement = sql.SQL(
        "SELECT allowed, retry_after_ms, remaining, reset_after_ms "
        "FROM app.{function}(%s, %s, %s::interval, %s, %s)"
    ).format(function=sql.Identifier(function))
    parameters = [key, shape.rate, shape.period, shape.burst, cost]
    row = connection.execute(statement, parameters).fetchone()
    assert row is not None
    allowed, retry_ms, remaining, reset_ms = row
    assert isinstance(retry_ms, int)
    assert isinstance(remaining, int)
    assert isinstance(reset_ms, int)
    return allowed is True, retry_ms, remaining, reset_ms


def _count(value: object) -> int:
    assert isinstance(value, int)
    return value


@pytest.fixture(autouse=True)
def _clean(admin_connection: Connection) -> None:
    admin_connection.execute("TRUNCATE app.rate_limit_bucket, app.upstream_budget")


@pytest.mark.parametrize("function", ["rate_limit_take", "upstream_budget_take"])
def test_a_bucket_allows_its_burst_counts_down_and_then_refuses(
    app_connection: Connection, function: str
) -> None:
    results = [_take(app_connection, function, "k", THREE_PER_HOUR) for _ in range(4)]

    assert [result[0] for result in results] == [True, True, True, False]
    assert [result[2] for result in results] == [2, 1, 0, 0]
    assert results[0][1] == 0
    assert 1_100_000 <= results[3][1] <= 1_200_000  # one token takes 3600 s / 3 = 1200 s
    assert 3_500_000 <= results[3][3] <= 3_600_000  # full again after the whole window


def test_a_denied_take_does_not_move_the_bucket(app_connection: Connection) -> None:
    for _ in range(3):
        _take(app_connection, "rate_limit_take", "k", THREE_PER_HOUR)
    first = _take(app_connection, "rate_limit_take", "k", THREE_PER_HOUR)
    second = _take(app_connection, "rate_limit_take", "k", THREE_PER_HOUR)

    assert first[0] is second[0] is False
    assert abs(first[1] - second[1]) < 5_000  # only the wall clock moved, not the bucket


def test_a_cost_takes_that_many_tokens_at_once(app_connection: Connection) -> None:
    taken = _take(app_connection, "rate_limit_take", "k", TEN_PER_HOUR, cost=4)
    too_much = _take(app_connection, "rate_limit_take", "k", TEN_PER_HOUR, cost=7)
    fits = _take(app_connection, "rate_limit_take", "k", TEN_PER_HOUR, cost=6)

    assert (taken[0], taken[2]) == (True, 6)
    assert (too_much[0], too_much[2]) == (False, 6)
    assert too_much[1] > 0
    assert (fits[0], fits[2]) == (True, 0)


def test_a_bucket_refills_as_time_passes(
    app_connection: Connection, admin_connection: Connection
) -> None:
    for _ in range(2):
        _take(app_connection, "rate_limit_take", "k", TWO_PER_HOUR)
    assert _take(app_connection, "rate_limit_take", "k", TWO_PER_HOUR)[0] is False

    admin_connection.execute(
        "UPDATE app.rate_limit_bucket SET tat = tat - interval '31 minutes' WHERE key = 'k'"
    )

    assert _take(app_connection, "rate_limit_take", "k", TWO_PER_HOUR)[0] is True


@pytest.mark.parametrize(
    ("rate", "period", "burst", "cost"),
    [
        (0, "1 minute", 1, 1),
        (1, "1 minute", 0, 1),
        (1, "1 minute", 1, 0),
        (1, "1 minute", 1, 2),
        (1, "0 seconds", 1, 1),
        (1, "-1 minutes", 1, 1),
    ],
)
def test_nonsense_parameters_are_refused(
    app_connection: Connection, rate: int, period: str, burst: int, cost: int
) -> None:
    with pytest.raises(errors.InvalidParameterValue):
        _take(app_connection, "rate_limit_take", "k", Shape(rate, period, burst), cost)


def test_buckets_expire_ten_minutes_after_they_are_full_again(
    app_connection: Connection, admin_connection: Connection
) -> None:
    _take(app_connection, "rate_limit_take", "k", TWO_PER_HOUR)

    row = admin_connection.execute(
        "SELECT expires_at - tat FROM app.rate_limit_bucket WHERE key = 'k'"
    ).fetchone()

    assert row == (timedelta(minutes=10),)


def test_cleanup_reports_per_table_counts_and_spares_live_rows(
    app_connection: Connection, admin_connection: Connection
) -> None:
    past = datetime.now(UTC) - timedelta(hours=1)
    future = datetime.now(UTC) + timedelta(hours=1)
    admin_connection.execute("TRUNCATE app.geocode_cache, app.plan")
    for key, expires in (("old-1", past), ("old-2", past), ("live", future)):
        admin_connection.execute(
            "INSERT INTO app.geocode_cache (key, payload, provider, expires_at) "
            "VALUES (%s, '[]', 'p', %s)",
            [key, expires],
        )
    admin_connection.execute(
        "INSERT INTO app.plan (id, request_hash, request, result, expires_at) "
        "VALUES ('pln_old', 'h', '{}', '{}', %s)",
        [past],
    )

    cleaned = app_connection.execute("SELECT table_name, deleted FROM app.cleanup_expired()")
    deleted = {str(name): _count(count) for name, count in cleaned.fetchall()}

    assert deleted["geocode_cache"] == 2
    assert deleted["plan"] == 1
    assert deleted["weather_cache"] == 0
    assert set(deleted) == {
        "geocode_cache",
        "route_cache",
        "weather_cache",
        "plan",
        "rate_limit_bucket",
        "single_flight_lease",
        "upstream_budget",
    }
    assert admin_connection.execute("SELECT key FROM app.geocode_cache").fetchall() == [("live",)]
