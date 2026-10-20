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
    assert settings.MIDDLEWARE == [
        "haulcast.api.middleware.RequestContextMiddleware",
        "django.middleware.security.SecurityMiddleware",
        "haulcast.api.middleware.RequestGuardMiddleware",
        "haulcast.api.ratelimit.RateLimitMiddleware",
    ]
    assert not any(
        "session" in entry.lower() or "cookie" in entry.lower() for entry in settings.MIDDLEWARE
    )


def test_request_bodies_are_capped_at_sixteen_kibibytes() -> None:
    assert settings.DATA_UPLOAD_MAX_MEMORY_SIZE == 16 * 1024


def test_debug_is_off_and_the_templates_engine_serves_only_the_docs_ui() -> None:
    assert settings.DEBUG is False
    assert settings.INSTALLED_APPS == ["ninja", "haulcast.store"]


def test_suite_only_ever_reaches_a_loopback_database() -> None:
    assert settings.DATABASES["default"]["HOST"] in {"127.0.0.1", "localhost", "::1"}
