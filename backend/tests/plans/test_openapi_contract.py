"""The OpenAPI document of the plan endpoints: responses validate, enums have one source."""

from collections.abc import Iterator
from typing import Any

import pytest
import respx
from django.test import Client
from jsonschema import Draft202012Validator

from haulcast.domain import DecidedBy, Factor, RiskLevel, RouteStatus
from haulcast.problems import PROBLEMS
from haulcast.services.container import risk_rules, scenario_catalog
from haulcast.services.plan_document import MilesByLevelDoc
from tests.plans.fakes import coverage_decided_plan
from tests.plans.support import (
    NEWARK_JERSEY_CITY,
    WeatherUpstream,
    benign,
    body,
    mock_routing,
    next_hour,
)
from tests.plans.test_create_plan import post

pytestmark = pytest.mark.django_db


def walk(node: object) -> Iterator[object]:
    """Yield every JSON value nested in ``node``."""
    yield node
    if isinstance(node, dict):
        for value in node.values():
            yield from walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from walk(value)


@pytest.fixture
def document(client: Client) -> dict[str, Any]:
    response = client.get("/api/v1/openapi.json")
    parsed: dict[str, Any] = response.json()
    return parsed


def validator(
    document: dict[str, Any], operation: tuple[str, str], status: str
) -> Draft202012Validator:
    """A JSON Schema validator for the response ``status`` of ``operation`` (path, method)."""
    path, method = operation
    schema = document["paths"][path][method]["responses"][status]["content"]["application/json"][
        "schema"
    ]
    return Draft202012Validator({**schema, "components": document["components"]})


def test_created_plans_heatmaps_and_problems_validate_against_the_published_schema(
    client: Client, upstream: respx.MockRouter, document: dict[str, Any]
) -> None:
    mock_routing(upstream, NEWARK_JERSEY_CITY)
    WeatherUpstream(upstream, benign)
    created = post(client, body(NEWARK_JERSEY_CITY, next_hour(), interval=10))
    plan = created.json()
    heatmap = client.get(f"/api/v1/plans/{plan['plan_id']}/heatmap").json()
    missing = client.get("/api/v1/plans/pln_" + "0" * 26).json()
    refused = post(client, {"origin": 1}).json()

    validator(document, ("/api/v1/plans", "post"), "201").validate(plan)
    validator(document, ("/api/v1/plans/{plan_id}", "get"), "200").validate(plan)
    validator(document, ("/api/v1/plans/{plan_id}/heatmap", "get"), "200").validate(heatmap)
    validator(document, ("/api/v1/plans/{plan_id}", "get"), "404").validate(missing)
    validator(document, ("/api/v1/plans", "post"), "422").validate(refused)


def test_a_plan_decided_by_coverage_validates_against_the_published_schema(
    document: dict[str, Any],
) -> None:
    plan = coverage_decided_plan().model_dump(mode="json")

    assert plan["recommendation"]["decided_by"] == "coverage"
    validator(document, ("/api/v1/plans", "post"), "201").validate(plan)
    validator(document, ("/api/v1/plans/{plan_id}", "get"), "200").validate(plan)


def test_the_operations_are_published_with_their_documented_statuses(
    document: dict[str, Any],
) -> None:
    post_responses = set(document["paths"]["/api/v1/plans"]["post"]["responses"])
    get_plan = set(document["paths"]["/api/v1/plans/{plan_id}"]["get"]["responses"])
    get_heatmap = set(document["paths"]["/api/v1/plans/{plan_id}/heatmap"]["get"]["responses"])

    assert {"200", "201", "400", "422", "429", "502", "503"} <= post_responses
    assert {"200", "304", "404", "429"} <= get_plan
    assert {"200", "304", "404", "429", "502", "503"} <= get_heatmap
    assert document["paths"]["/api/v1/plans"]["post"]["operationId"] == "createPlan"
    assert document["paths"]["/api/v1/plans/{plan_id}"]["get"]["operationId"] == "getPlan"
    assert (
        document["paths"]["/api/v1/plans/{plan_id}/heatmap"]["get"]["operationId"] == "getHeatmap"
    )


def test_every_enumeration_is_published_from_its_single_source(document: dict[str, Any]) -> None:
    enums = [
        node["enum"]
        for node in walk(document["components"])
        if isinstance(node, dict) and "enum" in node
    ]
    schemas = document["components"]["schemas"]

    assert [level.id for level in RiskLevel] in enums
    assert [item.value for item in DecidedBy] == schemas["DecidedBy"]["enum"]
    assert [item.value for item in RouteStatus] == schemas["RouteStatus"]["enum"]
    assert [item.value for item in Factor] == schemas["Factor"]["enum"]
    assert list(risk_rules().sampling_intervals_mi) in enums
    assert [item.id for item in scenario_catalog().summaries()] in enums
    assert list(PROBLEMS) in enums
    assert ["valhalla", "osrm"] in enums
    assert ["open-meteo", "scenario"] in enums


def test_the_request_schema_forbids_unknown_fields_and_carries_the_rules_ranges(
    document: dict[str, Any],
) -> None:
    schema = document["components"]["schemas"]["PlanRequestSchema"]
    load = schema["properties"]["load_weight_lb"]

    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == {
        "origin",
        "destination",
        "departure_time",
        "load_weight_lb",
        "sampling_interval_mi",
    }
    assert (load["minimum"], load["maximum"]) == (
        risk_rules().load_min_lb,
        risk_rules().load_max_lb,
    )


def test_the_miles_by_level_keys_are_the_domains_risk_levels() -> None:
    assert set(MilesByLevelDoc.model_fields) == {level.id for level in RiskLevel}
