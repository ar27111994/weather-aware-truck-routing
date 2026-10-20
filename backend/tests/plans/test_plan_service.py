"""The plan service: validation, idempotency, caps, failure mapping and budgets (real Postgres)."""

from dataclasses import replace
from datetime import timedelta
from types import TracebackType

import pytest

import haulcast.services.plan_service as plan_service_module
from haulcast.domain import Factor
from haulcast.problems import ProblemError
from haulcast.providers.errors import ProviderUnavailableError
from haulcast.providers.routing.base import NoRouteFoundError, RoutingUnavailableError
from haulcast.services.container import risk_rules
from haulcast.services.locks import LockUnavailableError
from haulcast.services.plan_service import MAX_ROUTE_MI, REQUEST_BUDGET_S
from haulcast.store.models import Plan
from tests.plans.fakes import (
    DEPARTURE,
    FIXED_NOW,
    Clock,
    ScriptedRouting,
    ScriptedWeather,
    Services,
    Ticker,
    build_services,
    minutes,
    request_for,
    result_of,
    runtime,
    straight_route,
)

pytestmark = pytest.mark.django_db


def short_trip() -> ScriptedRouting:
    """A routing provider with one 300 mile route (a handful of checkpoints: cheap to score)."""
    return ScriptedRouting(result_of(straight_route(300, points=60)))


def services(**changes: object) -> Services:
    return build_services(short_trip(), **changes)  # type: ignore[arg-type]


class NeverGranted:
    """An advisory lock that is never granted, as when another request holds it too long."""

    def __init__(self, name: str, *, timeout_s: float) -> None:  # noqa: ARG002 - lock signature
        self.name = name

    def __enter__(self) -> None:
        raise LockUnavailableError(self.name)

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        return None


# --------------------------------------------------------------------------- creating and reading


def test_a_new_plan_is_stored_and_read_back_unchanged() -> None:
    under_test = services()

    outcome = under_test.plans.create(request_for(interval=50))

    document = outcome.document
    row = Plan.objects.get(id=document.plan_id)
    assert outcome.created is True
    assert document.plan_id == "pln_00000000000000000000000001"
    assert document.created_at == FIXED_NOW
    assert document.expires_at == FIXED_NOW + timedelta(days=7)
    assert row.result == document.model_dump(mode="json")
    assert row.request == document.request.model_dump(mode="json")
    assert row.request_hash == request_for(interval=50).normalized().request_hash
    assert row.heatmap is None
    assert under_test.plans.get(document.plan_id) == document


@pytest.mark.parametrize(
    "bad_id",
    ["", "nope", "pln_", "../hosts", "pln_" + "Z" * 26, "pln_" + "0" * 25, "pln_" + "0" * 27],
)
def test_an_unknown_or_malformed_plan_id_is_not_found(bad_id: str) -> None:
    with pytest.raises(ProblemError) as caught:
        services().plans.get(bad_id)

    assert (caught.value.code, caught.value.status) == ("plan_not_found", 404)


def test_a_plan_expires_after_seven_days() -> None:
    clock = Clock()
    under_test = services(rt=runtime(clock))
    plan_id = under_test.plans.create(request_for(interval=50)).document.plan_id

    clock.now = FIXED_NOW + timedelta(days=7) - timedelta(seconds=1)
    assert under_test.plans.get(plan_id).plan_id == plan_id
    clock.now = FIXED_NOW + timedelta(days=7)
    with pytest.raises(ProblemError) as caught:
        under_test.plans.get(plan_id)

    assert caught.value.code == "plan_not_found"


# --------------------------------------------------------------------------- idempotency window


def test_an_identical_request_inside_ten_minutes_reuses_the_plan_and_after_it_makes_a_new_one() -> (
    None
):
    clock = Clock()
    under_test = services(rt=runtime(clock))
    first = under_test.plans.create(request_for(interval=50))

    clock.now = FIXED_NOW + minutes(9.9)
    inside = under_test.plans.create(request_for(interval=50))
    clock.now = FIXED_NOW + minutes(10.1)
    after = under_test.plans.create(request_for(interval=50))

    assert (first.created, inside.created, after.created) == (True, False, True)
    assert inside.document == first.document
    assert after.document.plan_id != first.document.plan_id
    assert len(under_test.routing.calls) == 1, "the route cache outlives the idempotency window"
    assert Plan.objects.count() == 2


# --------------------------------------------------------------------------- the departure window


@pytest.mark.parametrize(
    ("offset", "accepted"),
    [
        (-timedelta(minutes=35), True),
        (-timedelta(minutes=36), False),
        (timedelta(hours=120) - timedelta(minutes=20), True),
        (timedelta(hours=120) - timedelta(minutes=19), False),
    ],
    ids=["15-min-ago", "16-min-ago", "120-h-ahead", "just-past-120-h"],
)
def test_the_departure_must_be_within_the_window(offset: timedelta, *, accepted: bool) -> None:
    """The fixed clock is 13:40; the offsets are relative to the 14:00 baseline departure."""
    request = request_for(interval=50, departure=DEPARTURE + offset)

    if accepted:
        assert services().plans.create(request).created is True
        return
    with pytest.raises(ProblemError) as caught:
        services().plans.create(request)

    problem = caught.value
    assert (problem.code, problem.status) == ("departure_out_of_range", 422)
    assert [error.loc for error in problem.errors] == [("body", "departure_time")]
    assert Plan.objects.count() == 0


# --------------------------------------------------------------------------- the two places


@pytest.mark.parametrize(("miles", "accepted"), [(0.9, False), (1.1, True)])
def test_origin_and_destination_must_be_at_least_a_mile_apart(
    miles: float, *, accepted: bool
) -> None:
    request = request_for(miles_apart=miles, interval=50)

    if accepted:
        assert services().plans.create(request).created is True
        return
    with pytest.raises(ProblemError) as caught:
        services().plans.create(request)

    assert caught.value.code == "same_origin_destination"
    assert [error.loc for error in caught.value.errors] == [("body", "destination")]


# --------------------------------------------------------------------------- the caps


def test_a_route_of_exactly_3000_miles_is_accepted_and_longer_is_refused() -> None:
    assert MAX_ROUTE_MI == 3_000.0
    exactly = build_services(ScriptedRouting(result_of(straight_route(3_000.0, points=300))))
    assert exactly.plans.create(request_for(interval=50)).created is True

    longer = build_services(ScriptedRouting(result_of(straight_route(3_000.5, points=300))))
    with pytest.raises(ProblemError) as caught:
        longer.plans.create(request_for(interval=50, load=30_000))

    assert (caught.value.code, caught.value.status) == ("route_too_long", 422)
    assert "3,000" in (caught.value.detail or "")


def test_too_many_weather_locations_are_refused_naming_the_interval_that_fits() -> None:
    under_test = build_services(ScriptedRouting(result_of(straight_route(2_900, points=400))))

    with pytest.raises(ProblemError) as caught:
        under_test.plans.create(request_for(interval=10))

    problem = caught.value
    assert (problem.code, problem.status) == ("too_many_checkpoints", 422)
    assert "291" in (problem.detail or "")
    assert "Use a 25 mi checkpoint interval" in (problem.detail or "")
    assert [error.loc for error in problem.errors] == [("body", "sampling_interval_mi")]
    assert Plan.objects.count() == 0
    assert under_test.weather.fetches == [], "no forecast is paid for a plan that is refused"
    assert under_test.plans.create(request_for(interval=25)).created is True


def test_the_advice_skips_intervals_that_still_do_not_fit() -> None:
    """Three routes sharing no weather point: 3 x 117 at 25 mi is too many, 3 x 59 at 50 fits."""
    routes = [straight_route(2_900, points=400, lat_shift=shift) for shift in (0.0, 2.0, 4.0)]
    under_test = build_services(ScriptedRouting(result_of(*routes)))

    with pytest.raises(ProblemError) as caught:
        under_test.plans.create(request_for(interval=10))

    assert "Use a 50 mi checkpoint interval" in (caught.value.detail or "")


def test_when_no_interval_fits_the_refusal_says_so() -> None:
    narrow = replace(risk_rules(), sampling_intervals_mi=(10,))
    under_test = build_services(
        ScriptedRouting(result_of(straight_route(2_900, points=400))), rules=narrow
    )

    with pytest.raises(ProblemError) as caught:
        under_test.plans.create(request_for(interval=10))

    assert "too long to sample at any checkpoint interval" in (caught.value.detail or "")


# --------------------------------------------------------------------------- failures


def test_no_route_is_a_422_problem_and_is_not_cached() -> None:
    routing = ScriptedRouting(NoRouteFoundError("scripted", "no route"))
    under_test = build_services(routing)

    for _ in range(2):
        with pytest.raises(ProblemError) as caught:
            under_test.plans.create(request_for(interval=50))
        assert (caught.value.code, caught.value.status) == ("no_route_found", 422)

    assert len(routing.calls) == 2


def test_routing_down_is_a_503_that_passes_the_retry_hint_on() -> None:
    routing = ScriptedRouting(RoutingUnavailableError("down", retry_after_s=7.0))

    with pytest.raises(ProblemError) as caught:
        build_services(routing).plans.create(request_for(interval=50))

    problem = caught.value
    assert (problem.code, problem.status, problem.retry_after_s) == (
        "routing_unavailable",
        503,
        7.0,
    )


def test_an_unusable_route_from_the_provider_is_a_502() -> None:
    degenerate = replace(straight_route(300, points=10), coords=((-111.9, 40.7),) * 10)
    routing = ScriptedRouting(result_of(degenerate))

    with pytest.raises(ProblemError) as caught:
        build_services(routing).plans.create(request_for(interval=50))

    assert (caught.value.code, caught.value.status) == ("routing_unavailable", 502)


def test_weather_down_is_a_503_with_the_retry_hint_and_stores_nothing() -> None:
    weather = ScriptedWeather(
        failure=ProviderUnavailableError("open-meteo", "down", retry_after_s=9.0)
    )
    under_test = build_services(short_trip(), weather)

    with pytest.raises(ProblemError) as caught:
        under_test.plans.create(request_for(interval=50))

    problem = caught.value
    assert (problem.code, problem.status, problem.retry_after_s) == (
        "weather_unavailable",
        503,
        9.0,
    )
    assert Plan.objects.count() == 0


def test_invalid_forecast_values_are_noted_and_never_shown_as_numbers() -> None:
    under_test = build_services(short_trip(), ScriptedWeather(wind_mph=-5.0))

    document = under_test.plans.create(request_for(interval=50)).document

    assert document.warnings, "the invalid readings are reported"
    for route in document.routes:
        for checkpoint in route.checkpoints:
            assert checkpoint.weather.wind_mph is None
            assert checkpoint.risk.factors[Factor.WIND] is None


# --------------------------------------------------------------------------- the request budget


def test_a_request_that_outlasts_its_budget_is_a_retryable_503_and_stores_nothing() -> None:
    ticker = Ticker()
    routing = short_trip()
    routing.on_call.append(lambda: setattr(ticker, "now", ticker.now + REQUEST_BUDGET_S + 1))
    under_test = build_services(routing, rt=runtime(ticker=ticker))

    with pytest.raises(ProblemError) as caught:
        under_test.plans.create(request_for(interval=50))

    problem = caught.value
    assert (problem.code, problem.status, problem.retry_after_s) == (
        "service_unavailable",
        503,
        5.0,
    )
    assert "after routing" in (problem.detail or "")
    assert Plan.objects.count() == 0


def test_an_identical_request_still_being_computed_is_a_retryable_503(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(plan_service_module, "advisory_lock", NeverGranted)

    with pytest.raises(ProblemError) as caught:
        services().plans.create(request_for(interval=50))

    assert (caught.value.code, caught.value.status, caught.value.retry_after_s) == (
        "service_unavailable",
        503,
        5.0,
    )
