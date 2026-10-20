"""The OpenAPI document and the contract it publishes (typed clients are generated from it)."""

import json
import re
from typing import Any

import pytest
from django.test import Client

import haulcast
from haulcast.api.geocode import GeocodeResponse
from haulcast.api.health import HealthResponse, ReadyResponse
from haulcast.config.paths import shared_dir

OPENAPI = "/api/v1/openapi.json"
EXPECTED_PATHS = {
    "/api/v1/health",
    "/api/v1/health/ready",
    "/api/v1/geocode",
    "/api/v1/rules",
    "/api/v1/scenarios",
    "/api/v1/plans",
    "/api/v1/plans/{plan_id}",
    "/api/v1/plans/{plan_id}/heatmap",
    "/api/v1/internal/maintenance",
}
HTTP_METHODS = {"get", "put", "post", "delete", "options", "head", "patch", "trace"}

pytestmark = pytest.mark.django_db


@pytest.fixture
def document(client: Client) -> dict[str, Any]:
    """The generated OpenAPI document."""
    response = client.get(OPENAPI)
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body, dict)
    return dict(body)


def operations(document: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    """Every ``(path, method, operation)`` triple of the document."""
    return [
        (path, method, operation)
        for path, item in document["paths"].items()
        for method, operation in item.items()
        if method in HTTP_METHODS
    ]


# --------------------------------------------------------------------------- the committed contract


def test_the_document_matches_the_committed_contract(document: dict[str, Any]) -> None:
    """``shared/openapi.json`` is what CI and the generated typed client are built from.

    One committed snapshot serves every consumer (this test, the ``openapi`` CI job, the frontend
    types), so an API change that forgets to refresh it fails here before it reaches CI.
    """
    committed = json.loads((shared_dir() / "openapi.json").read_text(encoding="utf-8"))

    assert document == committed, (
        "shared/openapi.json is stale: run `pnpm run openapi:export` and commit the result"
    )


# --------------------------------------------------------------------------- shape


def test_the_document_is_openapi_3_and_describes_this_application(document: dict[str, Any]) -> None:
    assert document["openapi"].startswith("3.")
    assert document["info"]["title"] == "Haulcast API"
    assert document["info"]["version"] == haulcast.__version__


def test_exactly_the_documented_paths_exist(document: dict[str, Any]) -> None:
    assert set(document["paths"]) == EXPECTED_PATHS


def test_operation_ids_are_unique_and_camel_case(document: dict[str, Any]) -> None:
    ids = [operation["operationId"] for _, _, operation in operations(document)]

    assert len(ids) == len(set(ids))
    assert all(re.fullmatch(r"[a-z][A-Za-z0-9]*", identifier) for identifier in ids)
    assert {"getHealth", "getReadiness", "geocode", "getRules", "listScenarios"} <= set(ids)


def test_every_operation_documents_the_problem_schema_for_errors(document: dict[str, Any]) -> None:
    for path, method, operation in operations(document):
        for status in ("400", "429", "500"):
            content = operation["responses"][status]["content"]
            reference = content["application/json"]["schema"]["$ref"]
            assert reference.endswith("/ProblemSchema"), f"{method} {path} {status}"


def test_the_only_mutating_operations_are_the_cron_maintenance_and_plan_creation(
    document: dict[str, Any],
) -> None:
    mutating = {
        (path, method) for path, method, _ in operations(document) if method not in {"get", "head"}
    }

    assert mutating == {("/api/v1/internal/maintenance", "post"), ("/api/v1/plans", "post")}


def test_the_application_accepts_no_file_uploads(document: dict[str, Any]) -> None:
    rendered = str(document)

    assert "multipart" not in rendered
    assert "octet-stream" not in rendered
    assert "binary" not in rendered
    bodies = {
        (path, method): set(operation["requestBody"]["content"])
        for path, method, operation in operations(document)
        if "requestBody" in operation
    }
    assert bodies == {("/api/v1/plans", "post"): {"application/json"}}


def test_the_problem_schema_has_the_documented_members(document: dict[str, Any]) -> None:
    schema = document["components"]["schemas"]["ProblemSchema"]

    assert set(schema["properties"]) == {
        "type",
        "title",
        "status",
        "detail",
        "code",
        "errors",
        "request_id",
    }
    assert set(schema["required"]) == {"type", "title", "status", "code", "request_id"}


# --------------------------------------------------------------------------- contract examples


def test_the_contract_examples_validate_against_the_response_models() -> None:
    HealthResponse.model_validate({"status": "ok", "version": "0.1.0", "commit": "abc1234"})
    ReadyResponse.model_validate(
        {"status": "ok", "database": "ok", "version": "0.1.0", "commit": "abc1234"}
    )
    GeocodeResponse.model_validate(
        {
            "query": "denver",
            "results": [
                {
                    "id": "osm:R1411339",
                    "label": "Denver, Colorado, United States",
                    "name": "Denver",
                    "region": "Colorado",
                    "country": "United States",
                    "country_code": "US",
                    "kind": "city",
                    "lat": 39.7392,
                    "lon": -104.9903,
                }
            ],
        }
    )


# --------------------------------------------------------------------------- serving


def test_the_document_and_the_docs_ui_are_public(client: Client) -> None:
    document_response = client.get(OPENAPI, headers={"Origin": "https://elsewhere.example"})
    docs = client.get("/api/v1/docs")

    assert document_response["Access-Control-Allow-Origin"] == "*"
    assert docs.status_code == 200
    assert docs["Content-Type"].startswith("text/html")
