"""Rate limiting: per-endpoint policies, the in-process GCRA, the atomic PostgreSQL limiter."""

import logging

import pytest
from django.db import Error as DatabaseError
from django.db import connection

from haulcast.services.ratelimit import (
    DEFAULT,
    GEOCODE,
    HEATMAP,
    LIVENESS,
    PLANS,
    InMemoryRateLimiter,
    PostgresRateLimiter,
    RateDecision,
    RateLimitService,
    RatePolicy,
    RateRule,
    rate_limit_service,
    rule_for,
)
from haulcast.store.models import RateLimitBucket
from tests.services.conftest import FakeClock, run_concurrently

MINUTE_6 = RateRule("t", (RatePolicy("minute", 6, 60),))


# --------------------------------------------------------------------------- policies


def test_the_contract_limits_are_encoded() -> None:
    assert [(p.name, p.limit, p.window_s) for p in PLANS.policies] == [
        ("minute", 6, 60),
        ("day", 60, 86_400),
    ]
    assert [(p.limit, p.window_s) for p in HEATMAP.policies] == [(30, 60)]
    assert [(p.limit, p.window_s) for p in GEOCODE.policies] == [(60, 60)]
    assert [(p.limit, p.window_s) for p in DEFAULT.policies] == [(120, 60)]
    assert LIVENESS.local_only is True
    assert not any(rule.local_only for rule in (PLANS, HEATMAP, GEOCODE, DEFAULT))


@pytest.mark.parametrize(
    ("method", "path", "rule"),
    [
        ("POST", "/api/v1/plans", PLANS),
        ("POST", "/api/v1/plans/", PLANS),
        ("GET", "/api/v1/plans", DEFAULT),
        ("GET", "/api/v1/plans/pln_01JABCDEF/heatmap", HEATMAP),
        ("HEAD", "/api/v1/plans/pln_01JABCDEF/heatmap/", HEATMAP),
        ("POST", "/api/v1/plans/pln_01JABCDEF/heatmap", DEFAULT),
        ("GET", "/api/v1/plans/pln_01JABCDEF", DEFAULT),
        ("GET", "/api/v1/plans/a/b/heatmap", DEFAULT),
        ("GET", "/api/v1/geocode", GEOCODE),
        ("GET", "/api/v1/geocode/", GEOCODE),
        ("GET", "/api/v1/health", LIVENESS),
        ("HEAD", "/api/v1/health/", LIVENESS),
        ("GET", "/api/v1/health/ready", DEFAULT),
        ("GET", "/api/v1/rules", DEFAULT),
        ("GET", "/api/v1/scenarios", DEFAULT),
        ("POST", "/api/v1/internal/maintenance", DEFAULT),
        ("DELETE", "/api/v1/plans", DEFAULT),
        ("POST", "/api/v1/plans/../rules", DEFAULT),
        ("POST", "/api/v1/plansx", DEFAULT),
        ("GET", "/", DEFAULT),
    ],
)
def test_each_endpoint_is_governed_by_its_own_rule(method: str, path: str, rule: RateRule) -> None:
    assert rule_for(method, path) is rule


# --------------------------------------------------------------------------- in-process limiter


def test_the_in_process_limiter_allows_the_burst_then_refuses(clock: FakeClock) -> None:
    limiter = InMemoryRateLimiter(clock=clock)

    decisions = [limiter.take("client", MINUTE_6) for _ in range(7)]

    assert [decision.allowed for decision in decisions] == [True] * 6 + [False]
    assert [decision.statuses[0].remaining for decision in decisions] == [5, 4, 3, 2, 1, 0, 0]
    assert decisions[0].statuses[0].reset_after_s == pytest.approx(10.0)
    assert decisions[5].statuses[0].reset_after_s == pytest.approx(60.0)
    assert decisions[6].retry_after_s == pytest.approx(10.0)
    assert decisions[0].retry_after_s == 0.0


def test_the_in_process_limiter_refills_continuously(clock: FakeClock) -> None:
    limiter = InMemoryRateLimiter(clock=clock)
    for _ in range(6):
        limiter.take("client", MINUTE_6)

    clock.advance(10)
    one_token = limiter.take("client", MINUTE_6)
    refused_again = limiter.take("client", MINUTE_6)
    clock.advance(60)
    full_again = [limiter.take("client", MINUTE_6).allowed for _ in range(6)]

    assert (one_token.allowed, refused_again.allowed) == (True, False)
    assert refused_again.retry_after_s == pytest.approx(10.0)
    assert full_again == [True] * 6


def test_the_in_process_limiter_keeps_clients_and_scopes_apart(clock: FakeClock) -> None:
    limiter = InMemoryRateLimiter(clock=clock)
    for _ in range(6):
        limiter.take("alice", MINUTE_6)

    assert limiter.take("alice", MINUTE_6).allowed is False
    assert limiter.take("bob", MINUTE_6).allowed is True
    assert limiter.take("alice", RateRule("other", MINUTE_6.policies)).allowed is True


def test_a_refusal_by_a_later_policy_charges_no_earlier_policy(clock: FakeClock) -> None:
    limiter = InMemoryRateLimiter(clock=clock)
    both = RateRule("t", (RatePolicy("a", 10, 3600), RatePolicy("b", 2, 3600)))
    only_a = RateRule("t", (RatePolicy("a", 10, 3600),))

    decisions = [limiter.take("client", both) for _ in range(3)]
    probe = limiter.take("client", only_a)

    assert [decision.allowed for decision in decisions] == [True, True, False]
    assert decisions[2].statuses[-1].policy.name == "b"
    assert probe.statuses[0].remaining == 7  # three charges would have left 6


def test_idle_buckets_are_forgotten_so_memory_stays_bounded(clock: FakeClock) -> None:
    limiter = InMemoryRateLimiter(clock=clock, max_buckets=3)
    for client in ("a", "b", "c"):
        limiter.take(client, MINUTE_6)
    assert len(limiter) == 3

    clock.advance(1_000)
    limiter.take("d", MINUTE_6)

    assert len(limiter) == 1


def test_buckets_that_are_not_yet_full_survive_pruning(clock: FakeClock) -> None:
    limiter = InMemoryRateLimiter(clock=clock, max_buckets=2)
    limiter.take("a", MINUTE_6)
    limiter.take("b", MINUTE_6)

    limiter.take("c", MINUTE_6)

    assert len(limiter) == 3


# --------------------------------------------------------------------------- PostgreSQL limiter

RULE_HOURLY_20 = RateRule("pg", (RatePolicy("hour", 20, 3_600),))


@pytest.mark.django_db
def test_the_database_limiter_allows_the_burst_then_refuses() -> None:
    limiter = PostgresRateLimiter()

    decisions = [limiter.take("client", RateRule("pg-burst", MINUTE_6.policies)) for _ in range(7)]

    assert [decision.allowed for decision in decisions] == [True] * 6 + [False]
    assert [decision.statuses[0].remaining for decision in decisions] == [5, 4, 3, 2, 1, 0, 0]
    assert 9.0 <= decisions[6].retry_after_s <= 10.0
    assert 50.0 <= decisions[6].statuses[0].reset_after_s <= 60.0


@pytest.mark.django_db
def test_a_refusal_rolls_back_every_bucket_it_touched() -> None:
    limiter = PostgresRateLimiter()
    both = RateRule("pg-two", (RatePolicy("a", 10, 3600), RatePolicy("b", 2, 3600)))
    only_a = RateRule("pg-two", (RatePolicy("a", 10, 3600),))

    decisions = [limiter.take("client", both) for _ in range(3)]
    probe = limiter.take("client", only_a)

    assert [decision.allowed for decision in decisions] == [True, True, False]
    assert decisions[2].statuses[-1].policy.name == "b"
    assert probe.statuses[0].remaining == 7
    assert RateLimitBucket.objects.filter(key="pg-two:b:client").count() == 1


@pytest.mark.django_db
def test_database_buckets_are_per_client_and_per_policy_name() -> None:
    limiter = PostgresRateLimiter()
    for _ in range(6):
        limiter.take("alice", RateRule("pg-keys", MINUTE_6.policies))

    assert limiter.take("alice", RateRule("pg-keys", MINUTE_6.policies)).allowed is False
    assert limiter.take("bob", RateRule("pg-keys", MINUTE_6.policies)).allowed is True


@pytest.mark.django_db(transaction=True)
def test_the_limit_is_exact_under_concurrency() -> None:
    """80 calls from 16 threads race for 20 tokens: exactly 20 are allowed, never 19 or 21."""
    limiter = PostgresRateLimiter()

    def hammer(_: int) -> list[bool]:
        return [limiter.take("shared", RULE_HOURLY_20).allowed for _ in range(5)]

    outcomes = [allowed for batch in run_concurrently(16, hammer) for allowed in batch]

    assert len(outcomes) == 80
    assert outcomes.count(True) == 20
    assert outcomes.count(False) == 60


@pytest.mark.django_db(transaction=True)
def test_concurrent_clients_do_not_block_or_steal_from_each_other() -> None:
    limiter = PostgresRateLimiter()

    def own_bucket(index: int) -> list[bool]:
        return [limiter.take(f"client-{index}", RULE_HOURLY_20).allowed for _ in range(20)]

    results = run_concurrently(8, own_bucket)

    assert all(all(batch) for batch in results)


@pytest.mark.django_db
def test_the_sql_function_rejects_nonsense_parameters() -> None:
    with pytest.raises(DatabaseError), connection.cursor() as cursor:
        cursor.execute("SELECT * FROM app.rate_limit_take('k', 0, interval '1 minute', 1, 1)")


# --------------------------------------------------------------------------- the service


class _Recorder:
    """A limiter that records its calls and answers with a fixed decision."""

    def __init__(self, decision: RateDecision) -> None:
        self.decision = decision
        self.calls: list[tuple[str, RateRule]] = []

    def take(self, client_key: str, rule: RateRule) -> RateDecision:
        self.calls.append((client_key, rule))
        return self.decision


class _Unreachable:
    def take(self, client_key: str, rule: RateRule) -> RateDecision:
        raise DatabaseError(f"store down for {client_key} ({rule.scope})")


ALLOWED = RateDecision(allowed=True, retry_after_s=0.0, statuses=())
DENIED = RateDecision(allowed=False, retry_after_s=3.0, statuses=())


def test_the_service_uses_the_primary_limiter_for_ordinary_rules() -> None:
    primary, fallback = _Recorder(DENIED), _Recorder(ALLOWED)

    decision = RateLimitService(primary, fallback).take("k", DEFAULT)

    assert decision is DENIED
    assert primary.calls == [("k", DEFAULT)]
    assert fallback.calls == []


def test_liveness_never_touches_the_primary_limiter() -> None:
    primary, fallback = _Unreachable(), _Recorder(ALLOWED)

    decision = RateLimitService(primary, fallback).take("k", LIVENESS)

    assert decision is ALLOWED
    assert fallback.calls == [("k", LIVENESS)]


def test_a_database_failure_degrades_to_the_fallback_and_is_logged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    fallback = _Recorder(ALLOWED)

    with caplog.at_level(logging.WARNING, logger="haulcast.ratelimit"):
        decision = RateLimitService(_Unreachable(), fallback).take("k", DEFAULT)

    assert decision is ALLOWED
    assert fallback.calls == [("k", DEFAULT)]
    assert "rate_limit_store_unavailable" in caplog.text


def test_programming_errors_are_not_swallowed_as_database_outages() -> None:
    class Broken:
        def take(self, client_key: str, rule: RateRule) -> RateDecision:
            raise ZeroDivisionError(f"{client_key} {rule.scope}")

    with pytest.raises(ZeroDivisionError):
        RateLimitService(Broken(), _Recorder(ALLOWED)).take("k", DEFAULT)


def test_the_process_wide_service_is_built_once_until_its_cache_is_cleared() -> None:
    rate_limit_service.cache_clear()

    first = rate_limit_service()

    assert rate_limit_service() is first
    rate_limit_service.cache_clear()
    assert rate_limit_service() is not first
    rate_limit_service.cache_clear()
