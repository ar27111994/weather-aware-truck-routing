"""Guard rails on the Django settings the suite runs under (PROJECT.md lock + decision D-10)."""

import pytest
from django.conf import settings

BANNED_CONTRIB_APPS = (
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.messages",
    "django.contrib.sessions",
)


@pytest.mark.parametrize("app", BANNED_CONTRIB_APPS)
def test_stateless_api_installs_no_contrib_apps(app: str) -> None:
    assert app not in settings.INSTALLED_APPS


def test_store_app_is_installed() -> None:
    assert "haulcast.store" in settings.INSTALLED_APPS


def test_no_session_or_cookie_middleware() -> None:
    assert settings.MIDDLEWARE == ["django.middleware.security.SecurityMiddleware"]


def test_suite_only_ever_reaches_a_loopback_database() -> None:
    assert settings.DATABASES["default"]["HOST"] in {"127.0.0.1", "localhost", "::1"}
