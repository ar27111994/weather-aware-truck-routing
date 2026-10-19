"""Contract tests for ``GET /api/v1/health`` (API-CONTRACT: liveness that never touches the DB).

None of these tests carries the ``django_db`` marker, so pytest-django blocks database access:
passing at all proves the endpoint is DB-free.
"""

from django.test import Client

import haulcast


def test_health_reports_ok_version_and_commit(client: Client) -> None:
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response["Content-Type"].startswith("application/json")
    assert response.json() == {
        "status": "ok",
        "version": haulcast.__version__,
        "commit": "0000000",
    }


def test_health_rejects_unsafe_methods(client: Client) -> None:
    assert client.post("/api/v1/health").status_code == 405


def test_unknown_api_paths_are_404(client: Client) -> None:
    assert client.get("/api/v1/does-not-exist").status_code == 404


def test_openapi_document_describes_the_health_operation(client: Client) -> None:
    response = client.get("/api/v1/openapi.json")

    assert response.status_code == 200
    document = response.json()
    assert document["info"]["title"] == "Haulcast API"
    assert document["info"]["version"] == haulcast.__version__
    assert document["paths"]["/api/v1/health"]["get"]["operationId"] == "getHealth"


def test_docs_ui_is_served_as_html(client: Client) -> None:
    response = client.get("/api/v1/docs")

    assert response.status_code == 200
    assert response["Content-Type"].startswith("text/html")
