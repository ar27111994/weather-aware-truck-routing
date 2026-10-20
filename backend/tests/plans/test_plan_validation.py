"""``POST /api/v1/plans`` request validation: what is refused before the service is ever asked."""

import copy
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, NoReturn

import pytest
from django.test import Client

import haulcast.api.plans as plans_api
from haulcast.problems import ProblemError
from haulcast.services.plan_request import Place, PlanRequest
from tests.plans.support import PLANS, SLC_DENVER, ApiResponse, body

DEPARTURE = datetime(2026, 10, 20, 14, 0, tzinfo=UTC)
Mutation = Callable[[dict[str, Any]], None]


class Spy:
    """A plan service that records the requests it is given and always answers 'no route'."""

    def __init__(self) -> None:
        self.requests: list[PlanRequest] = []

    def create(self, request: PlanRequest) -> NoReturn:
        self.requests.append(request)
        raise ProblemError("no_route_found", detail="spy")


@pytest.fixture
def spy(monkeypatch: pytest.MonkeyPatch) -> Spy:
    watcher = Spy()
    monkeypatch.setattr(plans_api, "plan_service", lambda: watcher)
    return watcher


def valid() -> dict[str, Any]:
    return body(SLC_DENVER, DEPARTURE)


def post_json(client: Client, payload: object) -> ApiResponse:
    return client.post(PLANS, data=payload, content_type="application/json")


def set_path(*path: str, value: object) -> Mutation:
    def mutate(payload: dict[str, Any]) -> None:
        target = payload
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value

    return mutate


def drop(*path: str) -> Mutation:
    def mutate(payload: dict[str, Any]) -> None:
        target = payload
        for key in path[:-1]:
            target = target[key]
        del target[path[-1]]

    return mutate


CASES: list[tuple[str, Mutation, list[str]]] = [
    ("origin-lat-too-north", set_path("origin", "lat", value=90.0001), ["origin", "lat"]),
    ("origin-lat-too-south", set_path("origin", "lat", value=-90.5), ["origin", "lat"]),
    (
        "destination-lon-too-east",
        set_path("destination", "lon", value=180.5),
        ["destination", "lon"],
    ),
    (
        "destination-lon-too-west",
        set_path("destination", "lon", value=-181),
        ["destination", "lon"],
    ),
    ("lat-as-text", set_path("origin", "lat", value="40.7"), ["origin", "lat"]),
    ("lat-as-bool", set_path("origin", "lat", value=True), ["origin", "lat"]),
    ("lat-null", set_path("origin", "lat", value=None), ["origin", "lat"]),
    ("label-missing", drop("origin", "label"), ["origin", "label"]),
    ("label-empty", set_path("origin", "label", value=""), ["origin", "label"]),
    ("label-blank", set_path("origin", "label", value="   "), ["origin", "label"]),
    (
        "label-only-control-characters",
        set_path("origin", "label", value="\u0000\u200b"),
        ["origin", "label"],
    ),
    ("label-too-long", set_path("destination", "label", value="x" * 201), ["destination", "label"]),
    ("label-not-text", set_path("origin", "label", value=7), ["origin", "label"]),
    (
        "departure-without-zone",
        set_path("departure_time", value="2026-10-20T14:00:00"),
        ["departure_time"],
    ),
    ("departure-not-a-date", set_path("departure_time", value="tomorrow"), ["departure_time"]),
    ("departure-as-epoch", set_path("departure_time", value=1_792_504_800), ["departure_time"]),
    ("departure-missing", drop("departure_time"), ["departure_time"]),
    ("load-too-heavy", set_path("load_weight_lb", value=80_001), ["load_weight_lb"]),
    ("load-negative", set_path("load_weight_lb", value=-1), ["load_weight_lb"]),
    ("load-fractional", set_path("load_weight_lb", value=38_000.5), ["load_weight_lb"]),
    ("load-whole-float", set_path("load_weight_lb", value=38_000.0), ["load_weight_lb"]),
    ("load-as-text", set_path("load_weight_lb", value="38000"), ["load_weight_lb"]),
    ("load-as-bool", set_path("load_weight_lb", value=True), ["load_weight_lb"]),
    ("load-missing", drop("load_weight_lb"), ["load_weight_lb"]),
    ("interval-unknown", set_path("sampling_interval_mi", value=15), ["sampling_interval_mi"]),
    ("interval-float", set_path("sampling_interval_mi", value=25.0), ["sampling_interval_mi"]),
    ("interval-as-text", set_path("sampling_interval_mi", value="25"), ["sampling_interval_mi"]),
    ("interval-missing", drop("sampling_interval_mi"), ["sampling_interval_mi"]),
    ("scenario-unknown", set_path("scenario", value="meteor-strike"), ["scenario"]),
    ("scenario-not-text", set_path("scenario", value=5), ["scenario"]),
    ("origin-missing", drop("origin"), ["origin"]),
    ("extra-top-level-field", set_path("callback", value="https://evil.example"), ["callback"]),
    (
        "extra-place-field",
        set_path("origin", "url", value="https://evil.example"),
        ["origin", "url"],
    ),
]


@pytest.mark.parametrize(
    ("mutate", "location"),
    [pytest.param(mutate, location, id=name) for name, mutate, location in CASES],
)
def test_an_invalid_body_is_a_422_problem_naming_the_field_and_never_reaches_the_service(
    client: Client, spy: Spy, mutate: Mutation, location: list[str]
) -> None:
    payload = copy.deepcopy(valid())
    mutate(payload)

    response = post_json(client, payload)

    problem = response.json()
    assert response.status_code == 422
    assert response["Content-Type"] == "application/problem+json"
    assert problem["code"] == "validation_error"
    assert problem["errors"][0]["loc"] == ["body", *location]
    assert problem["request_id"]
    assert spy.requests == []


@pytest.mark.parametrize("token", ["NaN", "Infinity", "-Infinity"])
def test_non_finite_numbers_are_refused(client: Client, spy: Spy, token: str) -> None:
    text = (
        '{"origin": {"lat": TOKEN, "lon": -111.891, "label": "A"},'
        ' "destination": {"lat": 39.7, "lon": -104.9, "label": "B"},'
        ' "departure_time": "2026-10-20T14:00:00Z", "load_weight_lb": 1,'
        ' "sampling_interval_mi": 25}'
    ).replace("TOKEN", token)

    response = post_json(client, text)

    assert response.status_code == 422
    assert response.json()["errors"][0]["loc"] == ["body", "origin", "lat"]
    assert spy.requests == []


def test_a_valid_body_reaches_the_service_cleaned_and_typed(client: Client, spy: Spy) -> None:
    payload = valid()
    payload["origin"] = {"lat": 40, "lon": -111, "label": "  Salt\u200b Lake\x00 City \n"}
    del payload["scenario"]
    payload["departure_time"] = "2026-10-20T08:00:00-06:00"

    response = post_json(client, payload)

    assert response.status_code == 422
    assert response.json()["code"] == "no_route_found"
    (received,) = spy.requests
    assert received.origin == Place(40.0, -111.0, "Salt Lake City")
    assert received.destination == Place(39.7392, -104.9903, SLC_DENVER.destination_label)
    assert received.departure == DEPARTURE
    assert received.scenario is None
    assert (received.load_weight_lb, received.sampling_interval_mi) == (38_000, 25)


@pytest.mark.parametrize(
    "scenario", ["calm", "storm-on-fastest", "high-wind-corridor", "gulf-downpour"]
)
def test_every_catalog_scenario_is_accepted(client: Client, spy: Spy, scenario: str) -> None:
    payload = valid()
    payload["scenario"] = scenario

    post_json(client, payload)

    assert spy.requests[0].scenario == scenario
