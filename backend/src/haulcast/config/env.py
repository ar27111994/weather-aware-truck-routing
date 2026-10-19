"""Typed, 12-factor environment parsing.

Everything here is a pure function of a mapping, so every branch is unit-testable without touching
``os.environ``. Absence is lenient (callers choose fail-closed defaults); a *malformed* value always
raises :class:`ConfigError`, so a typo can never silently flip a security-relevant switch.
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final, Self
from urllib.parse import parse_qsl, unquote, urlsplit

_TRUE_VALUES: Final = frozenset({"1", "true", "yes", "on"})
_FALSE_VALUES: Final = frozenset({"0", "false", "no", "off"})
_POSTGRES_SCHEMES: Final = frozenset({"postgres", "postgresql"})
_SSL_MODES: Final = frozenset({"disable", "allow", "prefer", "require", "verify-ca", "verify-full"})
_DEFAULT_POSTGRES_PORT: Final = 5432
_COMMIT_VARIABLES: Final = ("COMMIT_SHA", "VERCEL_GIT_COMMIT_SHA")
_COMMIT_PATTERN: Final = re.compile(r"[0-9a-fA-F]{7,40}")
_COMMIT_DISPLAY_LENGTH: Final = 7

UNKNOWN_COMMIT: Final = "unknown"
"""Value reported by the health endpoint when no build SHA is configured."""


class ConfigError(ValueError):
    """An environment variable holds a value the application refuses to interpret."""


def env_bool(environ: Mapping[str, str], name: str, *, default: bool) -> bool:
    """Read a boolean flag: unset or blank yields ``default``, anything unrecognised raises."""
    raw = environ.get(name, "").strip().lower()
    if not raw:
        return default
    if raw in _TRUE_VALUES:
        return True
    if raw in _FALSE_VALUES:
        return False
    raise ConfigError(f"{name} must be one of 1/0, true/false, yes/no, on/off")


def env_csv(environ: Mapping[str, str], name: str) -> tuple[str, ...]:
    """Read a comma-separated list: whitespace is trimmed and empty items are dropped."""
    items = (item.strip() for item in environ.get(name, "").split(","))
    return tuple(item for item in items if item)


def database_from_url(url: str) -> dict[str, Any]:
    """Translate a ``postgresql://`` URL into a Django ``DATABASES`` entry.

    Only ``sslmode`` is accepted as a query parameter: passing arbitrary libpq options through would
    let a malformed variable change connection semantics. Error messages never echo the URL, which
    carries a password.

    Raises:
        ConfigError: the URL is not a well-formed PostgreSQL URL.
    """
    parts = urlsplit(url)
    if parts.scheme not in _POSTGRES_SCHEMES:
        raise ConfigError("database URL must use the postgres:// or postgresql:// scheme")
    if not parts.hostname:
        raise ConfigError("database URL has no host")
    name = unquote(parts.path.removeprefix("/"))
    if not name:
        raise ConfigError("database URL has no database name")
    try:
        explicit_port = parts.port
    except ValueError:
        raise ConfigError("database URL has an invalid port") from None
    port = _DEFAULT_POSTGRES_PORT if explicit_port is None else explicit_port
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    sslmode = query.pop("sslmode", None)
    if query:
        unsupported = ", ".join(sorted(query))
        raise ConfigError(f"database URL has unsupported query parameters: {unsupported}")
    if sslmode is not None and sslmode not in _SSL_MODES:
        raise ConfigError("database URL has an invalid sslmode")
    options: dict[str, str] = {} if sslmode is None else {"sslmode": sslmode}
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": name,
        "USER": unquote(parts.username or ""),
        "PASSWORD": unquote(parts.password or ""),
        "HOST": parts.hostname,
        "PORT": port,
        "OPTIONS": options,
    }


def _commit_from_env(environ: Mapping[str, str]) -> str:
    """Return the 7-character build SHA, or :data:`UNKNOWN_COMMIT` when none is configured."""
    for name in _COMMIT_VARIABLES:
        raw = environ.get(name, "").strip()
        if raw:
            if _COMMIT_PATTERN.fullmatch(raw) is None:
                raise ConfigError(f"{name} must be a 7-40 character hexadecimal git SHA")
            return raw[:_COMMIT_DISPLAY_LENGTH].lower()
    return UNKNOWN_COMMIT


@dataclass(frozen=True, slots=True)
class Config:
    """Deployment configuration parsed from the environment."""

    debug: bool
    secret_key: str
    allowed_hosts: tuple[str, ...]
    database_url: str | None
    commit: str

    @classmethod
    def from_env(cls, environ: Mapping[str, str]) -> Self:
        """Parse ``environ``, raising :class:`ConfigError` on malformed values.

        Missing values take fail-closed defaults: ``DEBUG`` is off, ``ALLOWED_HOSTS`` is empty
        (Django then rejects every host) and an empty ``DJANGO_SECRET_KEY`` makes Django raise
        ``ImproperlyConfigured`` the first time anything asks for it.
        """
        return cls(
            debug=env_bool(environ, "DEBUG", default=False),
            secret_key=environ.get("DJANGO_SECRET_KEY", ""),
            allowed_hosts=env_csv(environ, "ALLOWED_HOSTS"),
            database_url=environ.get("DATABASE_URL", "").strip() or None,
            commit=_commit_from_env(environ),
        )

    def django_databases(self) -> dict[str, dict[str, Any]]:
        """Return the ``DATABASES`` setting; empty (Django's dummy backend) without a URL."""
        if self.database_url is None:
            return {}
        return {"default": database_from_url(self.database_url)}
