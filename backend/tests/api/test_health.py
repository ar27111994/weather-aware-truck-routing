"""``GET /api/v1/health`` (liveness) and ``GET /api/v1/health/ready`` (readiness)."""

from typing import NoReturn

import pytest
from django.db import OperationalError
from django.test import Client

import haulcast

# --------------------------------------------------------------------------- liveness


def test_health_reports_ok_version_and_commit(client: Client) -> None:
    """No ``django_db`` marker: pytest-django blocks database access, proving it is DB-free."""
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response["Content-Type"].startswith("application/json")
    assert response.json() == {"status": "ok", "version": haulcast.__version__, "commit": "0000000"}


def test_health_answers_head_like_get_but_without_a_body(client: Client) -> None:
    """``curl -I`` (HEAD) is how deployments are smoke-tested, so it must work."""
    get = client.get("/api/v1/health")
    head = client.head("/api/v1/health")

    assert head.status_code == 200
    assert head.content == b""
    assert head["Content-Type"] == get["Content-Type"]
    assert head["Content-Length"] == str(len(get.content))
    assert head["X-Content-Type-Options"] == "nosniff"
    assert head["X-Request-ID"]


def test_a_head_request_to_a_missing_path_is_still_a_404_problem(client: Client) -> None:
    response = client.head("/api/v1/does-not-exist")

    assert response.status_code == 404
    assert response.content == b""
    assert response["Content-Type"] == "application/problem+json"


def test_health_is_not_cacheable_and_carries_the_security_headers(client: Client) -> None:
    response = client.get("/api/v1/health")

    assert response["Cache-Control"] == "no-store"
    assert response["X-Content-Type-Options"] == "nosniff"
    assert response["Cross-Origin-Resource-Policy"] == "same-origin"
    assert response["RateLimit-Policy"] == '"minute";q=120;w=60'


def test_health_survives_a_broken_database_because_it_never_touches_it(client: Client) -> None:
    for _ in range(3):
        assert client.get("/api/v1/health").status_code == 200


def test_health_rejects_posts_without_a_json_body_before_anything_else(client: Client) -> None:
    response = client.post("/api/v1/health")

    assert response.status_code == 400
    assert response.json()["code"] == "invalid_content_type"


@pytest.mark.django_db
def test_health_rejects_unsafe_methods_with_a_405_problem(client: Client) -> None:
    response = client.post("/api/v1/health", data="{}", content_type="application/json")

    assert response.status_code == 405
    assert response["Content-Type"] == "application/problem+json"
    assert response.json()["code"] == "method_not_allowed"
    assert response["Allow"] == "GET"


def test_unknown_api_paths_are_a_404_problem(client: Client) -> None:
    response = client.get("/api/v1/does-not-exist")

    assert response.status_code == 404
    assert response["Content-Type"] == "application/problem+json"
    assert response.json()["code"] == "not_found"


# --------------------------------------------------------------------------- readiness


@pytest.mark.django_db
def test_ready_reports_database_ok(client: Client) -> None:
    response = client.get("/api/v1/health/ready")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "database": "ok",
        "version": haulcast.__version__,
        "commit": "0000000",
    }
    assert response["Cache-Control"] == "no-store"


@pytest.mark.django_db
def test_ready_is_a_503_problem_with_retry_after_when_the_database_fails(
    client: Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    secret = "password-for-the-database-" + "must-not-leak"

    class BrokenConnection:
        """Stands in for ``django.db.connection`` when the server cannot be reached."""

        def cursor(self) -> NoReturn:
            raise OperationalError(f"connection failed: {secret}")

    monkeypatch.setattr("haulcast.api.health.connection", BrokenConnection())

    response = client.get("/api/v1/health/ready")

    body = response.json()
    assert response.status_code == 503
    assert response["Content-Type"] == "application/problem+json"
    assert response["Retry-After"] == "5"
    assert body["code"] == "database_unavailable"
    assert body["detail"] == "The database is not reachable."
    assert secret not in response.content.decode()


@pytest.mark.django_db
def test_ready_is_rate_limited_by_the_database_backed_default_policy(client: Client) -> None:
    response = client.get("/api/v1/health/ready")

    assert response["RateLimit-Policy"] == '"minute";q=120;w=60'
