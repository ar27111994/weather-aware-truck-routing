"""The WSGI entrypoint and Vercel's ``api/index.py`` must both serve the same Django application."""

import importlib.util
import json
import logging
import sys
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import Any
from wsgiref.util import setup_testing_defaults

import pytest
from django.http import HttpResponse

from haulcast.config.wsgi import application, report_startup_warnings

REPO_ROOT = Path(__file__).resolve().parents[2]


def _discard_written_bytes(_data: bytes) -> None:
    """The legacy WSGI ``write()`` callable; Django returns the body instead of writing it."""


def _load_vercel_entrypoint() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "vercel_entrypoint", REPO_ROOT / "api" / "index.py"
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.django_db  # WSGIHandler fires request_started, whose cleanup inspects DB connections
def test_wsgi_application_serves_the_health_endpoint() -> None:
    environ: dict[str, Any] = {
        "REQUEST_METHOD": "GET",
        "PATH_INFO": "/api/v1/health",
        "HTTP_HOST": "testserver",
    }
    setup_testing_defaults(environ)
    status_line: list[str] = []

    def start_response(
        status: str, _headers: list[tuple[str, str]], _exc_info: object = None, /
    ) -> Callable[[bytes], object]:
        status_line.append(status)
        return _discard_written_bytes

    response = application(environ, start_response)

    assert isinstance(response, HttpResponse)
    assert status_line == ["200 OK"]
    assert json.loads(response.content)["status"] == "ok"


def test_vercel_entrypoint_exposes_the_django_wsgi_callable_as_app() -> None:
    entrypoint = _load_vercel_entrypoint()

    assert entrypoint.app is application
    assert str(REPO_ROOT / "backend" / "src") in sys.path


def test_a_cold_start_logs_the_startup_warnings_of_its_environment(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("VERCEL_ENV", "production")
    monkeypatch.delenv("ALLOWED_HOSTS", raising=False)

    with caplog.at_level(logging.WARNING, logger="haulcast.config"):
        report_startup_warnings()

    assert [record.levelname for record in caplog.records] == ["WARNING"]
    assert "ALLOWED_HOSTS" in caplog.text


def test_a_cold_start_without_warnings_logs_nothing(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.delenv("VERCEL_ENV", raising=False)

    with caplog.at_level(logging.DEBUG, logger="haulcast.config"):
        report_startup_warnings()

    assert caplog.records == []
