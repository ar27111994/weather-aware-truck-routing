"""Typed, 12-factor environment parsing.

Everything here is a pure function of a mapping, so every branch is unit-testable without touching
``os.environ``. Absence is lenient (callers choose fail-closed defaults); a *malformed* value always
raises :class:`ConfigError`, so a typo can never silently flip a security-relevant switch. A
*deployed* environment (Vercel production/preview, or ``HAULCAST_ENV=production``) is stricter:
:meth:`Config.validate` refuses to start without the secrets and switches production needs, naming
the missing *variables* (never their values).
"""

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final, Self, TypedDict
from urllib.parse import parse_qsl, unquote, urlsplit

from haulcast.config.timeouts import DB_CONNECT_TIMEOUT_S, DB_MIGRATION_CONNECT_TIMEOUT_S

_TRUE_VALUES: Final = frozenset({"1", "true", "yes", "on"})
_FALSE_VALUES: Final = frozenset({"0", "false", "no", "off"})
_POSTGRES_SCHEMES: Final = frozenset({"postgres", "postgresql"})
_SSL_MODES: Final = frozenset({"disable", "allow", "prefer", "require", "verify-ca", "verify-full"})
_DEFAULT_POSTGRES_PORT: Final = 5432
_LOOPBACK_HOSTS: Final = frozenset({"127.0.0.1", "localhost", "::1"})
_COMMIT_VARIABLES: Final = ("COMMIT_SHA", "VERCEL_GIT_COMMIT_SHA")
_COMMIT_PATTERN: Final = re.compile(r"[0-9a-fA-F]{7,40}")
_COMMIT_DISPLAY_LENGTH: Final = 7
_HEADER_NAME_PATTERN: Final = re.compile(r"[A-Za-z0-9-]+")
_ORIGIN_PATTERN: Final = re.compile(r"https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?")
_DEPLOYED_VERCEL_ENVIRONMENTS: Final = frozenset({"production", "preview"})
_VERCEL_HOST_VARIABLES: Final = (
    "VERCEL_URL",
    "VERCEL_BRANCH_URL",
    "VERCEL_PROJECT_PRODUCTION_URL",
)
_HOST_LABEL: Final = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_HOST_NAME_PATTERN: Final = re.compile(rf"{_HOST_LABEL}(?:\.{_HOST_LABEL})+")
_MAX_HOST_NAME_LENGTH: Final = 253
_MIN_SECRET_KEY_LENGTH: Final = 50
_MIN_RATE_LIMIT_SALT_LENGTH: Final = 16
_MIN_CRON_SECRET_LENGTH: Final = 32
DEFAULT_TRUCK_TOP_SPEED_KPH: Final = 105.0
"""Cruising speed of a loaded truck when the setting is absent (the adapters share it)."""
_TRUCK_TOP_SPEED_RANGE_KPH: Final = (40.0, 120.0)

UNKNOWN_COMMIT: Final = "unknown"
"""Value reported by the health endpoint when no build SHA is configured."""

APP_ROLE: Final = "haulcast_app"
"""Least-privilege role the runtime connects as (DML only; no DDL)."""

OWNER_ROLE: Final = "haulcast_owner"
"""Role that owns schema ``app`` and runs migrations."""


class ConfigError(ValueError):
    """An environment variable holds a value the application refuses to interpret."""


class DatabaseOptions(TypedDict, total=False):
    """The libpq ``OPTIONS`` of a Django ``DATABASES`` entry, as far as this project sets them."""

    sslmode: str
    connect_timeout: int
    prepare_threshold: None
    options: str
    """libpq startup options: the test settings put the ``app`` schema on the search path."""


class DatabaseTestSettings(TypedDict):
    """The ``TEST`` block of a ``DATABASES`` entry."""

    NAME: str


class DatabaseEntry(TypedDict, total=False):
    """One entry of Django's ``DATABASES`` setting, as far as this project fills it (R2-27)."""

    ENGINE: str
    NAME: str
    USER: str
    PASSWORD: str
    HOST: str
    PORT: int
    OPTIONS: DatabaseOptions
    CONN_MAX_AGE: int
    CONN_HEALTH_CHECKS: bool
    DISABLE_SERVER_SIDE_CURSORS: bool
    TEST: DatabaseTestSettings


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


def env_float(
    environ: Mapping[str, str],
    name: str,
    *,
    default: float,
    bounds: tuple[float, float],
) -> float:
    """Read a finite float within ``bounds`` (inclusive); unset or blank yields ``default``."""
    raw = environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ConfigError(f"{name} must be a number") from None
    if not math.isfinite(value) or not bounds[0] <= value <= bounds[1]:
        raise ConfigError(f"{name} must be between {bounds[0]:g} and {bounds[1]:g}")
    return value


def env_origins(environ: Mapping[str, str], name: str) -> tuple[str, ...]:
    """Read a list of web origins (``https://host[:port]``), normalised to lower case."""
    origins: list[str] = []
    for item in env_csv(environ, name):
        normalised = item.rstrip("/").lower()
        if _ORIGIN_PATTERN.fullmatch(normalised) is None:
            raise ConfigError(f"{name} entries must look like https://host[:port]")
        origins.append(normalised)
    return tuple(origins)


def database_from_url(url: str) -> DatabaseEntry:
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
    options: DatabaseOptions = {} if sslmode is None else {"sslmode": sslmode}
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": name,
        "USER": unquote(parts.username or ""),
        "PASSWORD": unquote(parts.password or ""),
        "HOST": parts.hostname,
        "PORT": port,
        "OPTIONS": options,
    }


def default_sslmode(host: str) -> str:
    """Return the ``sslmode`` for a URL that names none: ``require``, ``prefer`` on loopback."""
    return "prefer" if host in _LOOPBACK_HOSTS else "require"


def role_database(
    url: str,
    *,
    role: str,
    password: str,
    runtime: bool,
) -> DatabaseEntry:
    """Return the ``DATABASES`` entry for connecting to ``url``'s server as ``role``.

    ``url`` supplies the coordinates only (host, port, database, ``sslmode``); its credentials are
    ignored, so a deployment never needs the owner password in the runtime environment. A Supabase
    pooler user ``postgres.<ref>`` makes the role ``<role>.<ref>``, as Supavisor requires.

    ``runtime`` entries are tuned for serverless transaction pooling: connections are never reused
    (``CONN_MAX_AGE=0``), server-side cursors and prepared statements are off, and ``sslmode``
    defaults to ``require`` for every non-loopback host. Every entry bounds how long opening a
    connection may take (``connect_timeout``): statement and idle-transaction limits cannot ride
    along as startup options (a transaction pooler may not forward them), so they are role
    defaults set by the bootstrap.

    Raises:
        ConfigError: ``url`` is not a well-formed PostgreSQL URL.
    """
    entry = database_from_url(url)
    tenant = entry["USER"].partition(".")[2]
    entry["USER"] = f"{role}.{tenant}" if tenant else role
    entry["PASSWORD"] = password
    entry["OPTIONS"].setdefault("sslmode", default_sslmode(entry["HOST"]))
    entry["OPTIONS"]["connect_timeout"] = (
        DB_CONNECT_TIMEOUT_S if runtime else DB_MIGRATION_CONNECT_TIMEOUT_S
    )
    if runtime:
        entry["OPTIONS"]["prepare_threshold"] = None
        entry["CONN_MAX_AGE"] = 0
        entry["CONN_HEALTH_CHECKS"] = False
        entry["DISABLE_SERVER_SIDE_CURSORS"] = True
    return entry


def _commit_from_env(environ: Mapping[str, str]) -> str:
    """Return the 7-character build SHA, or :data:`UNKNOWN_COMMIT` when none is configured."""
    for name in _COMMIT_VARIABLES:
        raw = environ.get(name, "").strip()
        if raw:
            if _COMMIT_PATTERN.fullmatch(raw) is None:
                raise ConfigError(f"{name} must be a 7-40 character hexadecimal git SHA")
            return raw[:_COMMIT_DISPLAY_LENGTH].lower()
    return UNKNOWN_COMMIT


def _client_ip_header(environ: Mapping[str, str]) -> str | None:
    """Return the platform header that carries the trustworthy client IP, if any.

    ``CLIENT_IP_HEADER`` wins; otherwise Vercel (its runtime sets ``VERCEL``) uses
    ``x-forwarded-for``, which the platform overwrites with the single public client IP. Anywhere
    else no header is trusted and the socket address is used.
    """
    explicit = environ.get("CLIENT_IP_HEADER", "").strip()
    if explicit:
        if _HEADER_NAME_PATTERN.fullmatch(explicit) is None:
            raise ConfigError("CLIENT_IP_HEADER must be a plain HTTP header name")
        return explicit.lower()
    return "x-forwarded-for" if env_bool(environ, "VERCEL", default=False) else None


def _vercel_hosts(environ: Mapping[str, str]) -> tuple[str, ...]:
    """Return the host names Vercel assigned to this deployment (empty anywhere else).

    A preview deployment is served from a host such as ``<project>-<hash>-<scope>.vercel.app``: one
    DNS label under ``vercel.app`` that changes with every deployment. Django's host patterns (an
    exact name, a leading-dot domain or ``*``) cannot list it statically, so the platform's system
    variables name it instead. A visitor cannot influence them, and only a bare, lower-cased host
    name is accepted from them: never a scheme, port, path or wildcard.

    Raises:
        ConfigError: a variable holds anything but a bare host name (the value is never echoed).
    """
    if not env_bool(environ, "VERCEL", default=False):
        return ()
    hosts: list[str] = []
    for name in _VERCEL_HOST_VARIABLES:
        raw = environ.get(name, "").strip().lower()
        if not raw:
            continue
        if len(raw) > _MAX_HOST_NAME_LENGTH or _HOST_NAME_PATTERN.fullmatch(raw) is None:
            raise ConfigError(f"{name} must be a bare host name")
        hosts.append(raw)
    return tuple(hosts)


def _allowed_hosts(environ: Mapping[str, str]) -> tuple[str, ...]:
    """Return ``ALLOWED_HOSTS`` followed by this deployment's own Vercel hosts, each once."""
    explicit = env_csv(environ, "ALLOWED_HOSTS")
    listed = {host.lower() for host in explicit}
    platform = [host for host in dict.fromkeys(_vercel_hosts(environ)) if host not in listed]
    return (*explicit, *platform)


@dataclass(frozen=True, slots=True)
class Config:
    """Deployment configuration parsed from the environment."""

    debug: bool
    secret_key: str
    allowed_hosts: tuple[str, ...]
    allowed_origins: tuple[str, ...]
    database_url: str | None
    database_url_pooled: str | None
    app_db_password: str
    owner_db_password: str
    rate_limit_salt: str
    cron_secret: str | None
    client_ip_header: str | None
    deployed: bool
    commit: str
    truck_top_speed_kph: float
    test_database_name: str | None

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
            allowed_hosts=_allowed_hosts(environ),
            allowed_origins=env_origins(environ, "ALLOWED_ORIGINS"),
            database_url=environ.get("DATABASE_URL", "").strip() or None,
            database_url_pooled=environ.get("DATABASE_URL_POOLED", "").strip() or None,
            app_db_password=environ.get("HAULCAST_APP_DB_PASSWORD", ""),
            owner_db_password=environ.get("HAULCAST_OWNER_DB_PASSWORD", ""),
            rate_limit_salt=environ.get("RATE_LIMIT_SALT", ""),
            cron_secret=environ.get("CRON_SECRET", "").strip() or None,
            client_ip_header=_client_ip_header(environ),
            deployed=(
                environ.get("VERCEL_ENV", "") in _DEPLOYED_VERCEL_ENVIRONMENTS
                or environ.get("HAULCAST_ENV", "") == "production"
            ),
            commit=_commit_from_env(environ),
            truck_top_speed_kph=env_float(
                environ,
                "TRUCK_TOP_SPEED_KPH",
                default=DEFAULT_TRUCK_TOP_SPEED_KPH,
                bounds=_TRUCK_TOP_SPEED_RANGE_KPH,
            ),
            test_database_name=environ.get("HAULCAST_TEST_DB_NAME", "").strip() or None,
        )

    def production_problems(self) -> tuple[str, ...]:
        """List what a production deployment is missing, by variable name (never by value)."""
        problems: list[str] = []
        if self.debug:
            problems.append("DEBUG must be off")
        if len(self.secret_key) < _MIN_SECRET_KEY_LENGTH:
            problems.append(
                f"DJANGO_SECRET_KEY must be at least {_MIN_SECRET_KEY_LENGTH} characters"
            )
        if not self.allowed_hosts:
            problems.append("ALLOWED_HOSTS must list at least one host")
        if len(self.rate_limit_salt) < _MIN_RATE_LIMIT_SALT_LENGTH:
            problems.append(
                f"RATE_LIMIT_SALT must be at least {_MIN_RATE_LIMIT_SALT_LENGTH} characters"
            )
        if self.database_url_pooled is None and self.database_url is None:
            problems.append("DATABASE_URL_POOLED (or DATABASE_URL) is required")
        if self.cron_secret is not None and len(self.cron_secret) < _MIN_CRON_SECRET_LENGTH:
            problems.append(
                f"CRON_SECRET must be at least {_MIN_CRON_SECRET_LENGTH} characters when set"
            )
        if not self.app_db_password:
            problems.append("HAULCAST_APP_DB_PASSWORD is required")
        return tuple(problems)

    def validate(self) -> None:
        """Refuse to start a deployed environment that misses production requirements.

        Raises:
            ConfigError: this is a deployed environment and :meth:`production_problems` lists gaps.
        """
        if not self.deployed:
            return
        problems = self.production_problems()
        if problems:
            raise ConfigError("invalid production configuration: " + "; ".join(problems))

    def django_databases(self) -> dict[str, DatabaseEntry]:
        """Return the ``DATABASES`` setting; empty (Django's dummy backend) without coordinates.

        ``default`` is the runtime connection (:data:`APP_ROLE` through the transaction pooler when
        ``DATABASE_URL_POOLED`` is set); ``owner`` is the migration connection (:data:`OWNER_ROLE`
        through ``DATABASE_URL``, the session pooler): ``manage.py migrate --database=owner``.
        """
        runtime_url = self.database_url_pooled or self.database_url
        if runtime_url is None:
            return {}
        default = role_database(
            runtime_url, role=APP_ROLE, password=self.app_db_password, runtime=True
        )
        if self.test_database_name is not None:
            default["TEST"] = {"NAME": self.test_database_name}
        owner = role_database(
            self.database_url or runtime_url,
            role=OWNER_ROLE,
            password=self.owner_db_password,
            runtime=False,
        )
        return {"default": default, "owner": owner}
