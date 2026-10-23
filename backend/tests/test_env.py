"""Unit tests for the typed environment parsing in ``haulcast.config.env``.

Everything under test is a pure function of a mapping, so no test touches ``os.environ`` or a
database. DSNs are assembled from parts at run time: no password literal ever appears in the file.
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import assert_type
from urllib.parse import quote

import pytest
from hypothesis import given
from hypothesis import strategies as st

from haulcast.config.env import (
    APP_ROLE,
    OWNER_ROLE,
    UNKNOWN_COMMIT,
    Config,
    ConfigError,
    DatabaseEntry,
    ProviderMode,
    database_from_url,
    default_replay_dir,
    default_sslmode,
    env_bool,
    env_csv,
    env_float,
    env_origins,
    role_database,
    startup_warnings,
)
from haulcast.config.timeouts import DB_CONNECT_TIMEOUT_S

TENANT = "abcdefghijklmnopqrst"
PASSWORD = "p@ss:word/with#odd" + "-chars"
POOLER_HOST = "aws-0-us-east-1.pooler.supabase.com"
SESSION_URL = (
    f"postgresql://postgres.{TENANT}:{quote(PASSWORD, safe='')}@{POOLER_HOST}:5432/postgres"
    "?sslmode=require"
)
POOLED_URL = SESSION_URL.replace(":5432/", ":6543/")
SECRET_KEY = "k" * 60
SALT = "s" * 24
PRODUCTION_ENV = {
    "VERCEL_ENV": "production",
    "DJANGO_SECRET_KEY": SECRET_KEY,
    "ALLOWED_HOSTS": "haulcast.vercel.app",
    "RATE_LIMIT_SALT": SALT,
    "DATABASE_URL_POOLED": POOLED_URL,
    "HAULCAST_APP_DB_PASSWORD": "a" * 24,
}


# --------------------------------------------------------------------------- env_bool


@pytest.mark.parametrize("raw", ["1", "true", "TRUE", "Yes", " on ", "\ttrue\n"])
def test_env_bool_accepts_truthy_spellings(raw: str) -> None:
    assert env_bool({"FLAG": raw}, "FLAG", default=False) is True


@pytest.mark.parametrize("raw", ["0", "false", "FALSE", "No", " off ", "\tfalse\n"])
def test_env_bool_accepts_falsy_spellings(raw: str) -> None:
    assert env_bool({"FLAG": raw}, "FLAG", default=True) is False


@pytest.mark.parametrize("environ", [{}, {"FLAG": ""}, {"FLAG": "   "}])
@pytest.mark.parametrize("default", [True, False])
def test_env_bool_falls_back_to_default_when_unset_or_blank(
    environ: dict[str, str], *, default: bool
) -> None:
    assert env_bool(environ, "FLAG", default=default) is default


@pytest.mark.parametrize("raw", ["2", "tru", "enabled", "nope"])
def test_env_bool_rejects_unrecognised_values_naming_the_variable(raw: str) -> None:
    with pytest.raises(ConfigError, match="FLAG must be one of"):
        env_bool({"FLAG": raw}, "FLAG", default=False)


@given(
    word=st.sampled_from(["1", "true", "yes", "on"]),
    flips=st.lists(st.booleans(), min_size=4, max_size=4),
    padding=st.text(alphabet=" \t", max_size=3),
)
def test_env_bool_ignores_case_and_padding_of_true_words(
    word: str, flips: list[bool], padding: str
) -> None:
    mixed = "".join(ch.upper() if flip else ch for ch, flip in zip(word, flips, strict=False))
    assert env_bool({"FLAG": f"{padding}{mixed}{padding}"}, "FLAG", default=False) is True


# --------------------------------------------------------------------------- env_csv


def test_env_csv_returns_empty_tuple_when_unset() -> None:
    assert env_csv({}, "HOSTS") == ()


def test_env_csv_trims_whitespace_and_drops_empty_items() -> None:
    environ = {"HOSTS": " localhost , ,127.0.0.1,, haulcast.vercel.app "}
    assert env_csv(environ, "HOSTS") == ("localhost", "127.0.0.1", "haulcast.vercel.app")


@given(st.lists(st.text(alphabet=st.characters(categories=("L", "N")), min_size=1), max_size=8))
def test_env_csv_round_trips_padded_items(items: list[str]) -> None:
    assert env_csv({"HOSTS": " , ".join(items)}, "HOSTS") == tuple(items)


# --------------------------------------------------------------------------- env_float


@pytest.mark.parametrize("environ", [{}, {"SPEED": ""}, {"SPEED": "  "}])
def test_env_float_falls_back_to_the_default_when_unset_or_blank(environ: dict[str, str]) -> None:
    assert env_float(environ, "SPEED", default=105.0, bounds=(40.0, 120.0)) == 105.0


@pytest.mark.parametrize(("raw", "expected"), [("40", 40.0), (" 87.5 ", 87.5), ("120.0", 120.0)])
def test_env_float_accepts_values_inside_the_inclusive_bounds(raw: str, expected: float) -> None:
    assert env_float({"SPEED": raw}, "SPEED", default=1.0, bounds=(40.0, 120.0)) == expected


@pytest.mark.parametrize("raw", ["fast", "1,5", "0x10"])
def test_env_float_rejects_text_that_is_not_a_number(raw: str) -> None:
    with pytest.raises(ConfigError, match="SPEED must be a number"):
        env_float({"SPEED": raw}, "SPEED", default=1.0, bounds=(40.0, 120.0))


@pytest.mark.parametrize("raw", ["39.99", "120.01", "-5", "nan", "inf", "-inf"])
def test_env_float_rejects_out_of_range_and_non_finite_numbers(raw: str) -> None:
    with pytest.raises(ConfigError, match="SPEED must be between 40 and 120"):
        env_float({"SPEED": raw}, "SPEED", default=1.0, bounds=(40.0, 120.0))


# --------------------------------------------------------------------------- env_origins


def test_env_origins_returns_empty_tuple_when_unset() -> None:
    assert env_origins({}, "ORIGINS") == ()


def test_env_origins_normalises_case_and_trailing_slashes() -> None:
    environ = {"ORIGINS": " HTTPS://Haulcast.Vercel.App/ , http://localhost:5173 "}
    assert env_origins(environ, "ORIGINS") == (
        "https://haulcast.vercel.app",
        "http://localhost:5173",
    )


@pytest.mark.parametrize(
    "raw",
    [
        "haulcast.vercel.app",
        "ftp://haulcast.vercel.app",
        "https://",
        "https://haulcast.vercel.app/path",
        "https://haul cast.example",
        "https://host:123456",
        "*",
        "null",
    ],
)
def test_env_origins_rejects_anything_that_is_not_scheme_host_and_optional_port(raw: str) -> None:
    with pytest.raises(ConfigError, match="ORIGINS entries must look like"):
        env_origins({"ORIGINS": raw}, "ORIGINS")


# --------------------------------------------------------------------------- database_from_url


def test_database_from_url_maps_a_supabase_pooler_url() -> None:
    assert database_from_url(POOLED_URL) == {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": "postgres",
        "USER": f"postgres.{TENANT}",
        "PASSWORD": PASSWORD,
        "HOST": POOLER_HOST,
        "PORT": 6543,
        "OPTIONS": {"sslmode": "require"},
    }


def test_database_from_url_defaults_port_password_and_options() -> None:
    entry = database_from_url("postgres://appuser@db.internal/appdb")
    assert entry["PORT"] == 5432
    assert entry["PASSWORD"] == ""
    assert entry["OPTIONS"] == {}


@pytest.mark.parametrize(
    ("url", "message"),
    [
        ("mysql://u@h/db", "scheme"),
        ("postgresql:///db", "no host"),
        ("postgresql://u@h", "no database name"),
        ("postgresql://u@h/", "no database name"),
        ("postgresql://u@h:notaport/db", "invalid port"),
        ("postgresql://u@h:70000/db", "invalid port"),
        ("postgresql://u@h/db?connect_timeout=3&application_name=x", "application_name, connect"),
        ("postgresql://u@h/db?sslmode=maybe", "invalid sslmode"),
    ],
)
def test_database_from_url_rejects_malformed_urls(url: str, message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        database_from_url(url)


def test_database_error_messages_never_echo_the_url_or_its_password() -> None:
    secret = "hunter2-" + "secret"
    with pytest.raises(ConfigError) as excinfo:
        database_from_url(f"mysql://admin:{secret}@db.internal/appdb")
    assert secret not in str(excinfo.value)
    assert "db.internal" not in str(excinfo.value)


# --------------------------------------------------------------------------- role_database


@pytest.mark.parametrize(
    ("host", "expected"),
    [("127.0.0.1", "prefer"), ("localhost", "prefer"), ("::1", "prefer"), (POOLER_HOST, "require")],
)
def test_default_sslmode_relaxes_only_for_loopback(host: str, expected: str) -> None:
    assert default_sslmode(host) == expected


def test_a_database_entry_is_typed_down_to_its_options() -> None:
    """R2-27: the settings boundary is a TypedDict, so mypy checks OPTIONS (``assert_type``)."""
    entry = role_database(POOLED_URL, role=APP_ROLE, password="runtime-secret-value", runtime=True)

    assert_type(entry, DatabaseEntry)
    assert_type(entry["OPTIONS"]["connect_timeout"], int)
    assert entry["OPTIONS"]["connect_timeout"] == DB_CONNECT_TIMEOUT_S


def test_role_database_swaps_credentials_but_keeps_the_coordinates() -> None:
    entry = role_database(POOLED_URL, role=APP_ROLE, password="runtime-secret-value", runtime=True)

    assert entry["USER"] == f"{APP_ROLE}.{TENANT}"
    assert entry["PASSWORD"] == "runtime-secret-value"
    assert (entry["HOST"], entry["PORT"], entry["NAME"]) == (POOLER_HOST, 6543, "postgres")
    assert PASSWORD not in repr(entry)


def test_role_database_uses_the_plain_role_name_without_a_supabase_tenant() -> None:
    entry = role_database(
        "postgresql://postgres@127.0.0.1:54329/haulcast",
        role=OWNER_ROLE,
        password="owner-secret-value",
        runtime=False,
    )

    assert entry["USER"] == OWNER_ROLE


def test_runtime_entries_are_tuned_for_serverless_transaction_pooling() -> None:
    entry = role_database(POOLED_URL, role=APP_ROLE, password="x" * 20, runtime=True)

    assert entry["CONN_MAX_AGE"] == 0
    assert entry["CONN_HEALTH_CHECKS"] is False
    assert entry["DISABLE_SERVER_SIDE_CURSORS"] is True
    assert entry["OPTIONS"] == {
        "sslmode": "require",
        "prepare_threshold": None,
        "connect_timeout": 3,
    }


def test_migration_entries_are_not_tuned_for_pooling() -> None:
    entry = role_database(SESSION_URL, role=OWNER_ROLE, password="x" * 20, runtime=False)

    assert "CONN_MAX_AGE" not in entry
    assert "DISABLE_SERVER_SIDE_CURSORS" not in entry
    assert entry["OPTIONS"] == {"sslmode": "require", "connect_timeout": 5}


@pytest.mark.parametrize(
    ("host", "expected"), [("127.0.0.1", "prefer"), ("db.internal.example", "require")]
)
def test_role_database_defaults_sslmode_by_host_when_the_url_names_none(
    host: str, expected: str
) -> None:
    url = f"postgresql://u@{host}/db"

    entry = role_database(url, role=APP_ROLE, password="x" * 20, runtime=True)

    assert entry["OPTIONS"]["sslmode"] == expected


def test_role_database_keeps_an_explicit_sslmode() -> None:
    entry = role_database(
        "postgresql://u@db.internal.example/db?sslmode=verify-full",
        role=APP_ROLE,
        password="x" * 20,
        runtime=True,
    )

    assert entry["OPTIONS"]["sslmode"] == "verify-full"


@given(st.text(min_size=1, max_size=40))
def test_role_database_always_replaces_the_url_password(secret: str) -> None:
    url = f"postgresql://postgres:{quote(secret, safe='')}@db.internal.example/db"

    entry = role_database(url, role=APP_ROLE, password="runtime-secret-value", runtime=True)

    assert entry["PASSWORD"] == "runtime-secret-value"


# --------------------------------------------------------------------------- Config.from_env


def test_config_defaults_are_fail_closed() -> None:
    config = Config.from_env({})

    assert config.debug is False
    assert config.secret_key == ""
    assert config.allowed_hosts == ()
    assert config.allowed_origins == ()
    assert config.database_url is None
    assert config.database_url_pooled is None
    assert config.cron_secret is None
    assert config.client_ip_header is None
    assert config.deployed is False
    assert config.commit == UNKNOWN_COMMIT
    assert config.truck_top_speed_kph == 105.0
    assert config.test_database_name is None
    assert config.django_databases() == {}


def test_config_parses_every_variable() -> None:
    config = Config.from_env(
        {
            "DEBUG": "true",
            "DJANGO_SECRET_KEY": SECRET_KEY,
            "ALLOWED_HOSTS": "localhost, haulcast.vercel.app",
            "ALLOWED_ORIGINS": "https://Haulcast.Vercel.App/",
            "DATABASE_URL": SESSION_URL,
            "DATABASE_URL_POOLED": f" {POOLED_URL} ",
            "HAULCAST_APP_DB_PASSWORD": "app-secret-value",
            "HAULCAST_OWNER_DB_PASSWORD": "owner-secret-value",
            "RATE_LIMIT_SALT": SALT,
            "CRON_SECRET": " cron-secret-value ",
            "CLIENT_IP_HEADER": "X-Real-IP",
            "VERCEL_ENV": "preview",
            "COMMIT_SHA": "0123456789ABCDEF",
            "TRUCK_TOP_SPEED_KPH": "95",
            "HAULCAST_TEST_DB_NAME": "test_haulcast_example",
        }
    )

    assert config.debug is True
    assert config.secret_key == SECRET_KEY
    assert config.allowed_hosts == ("localhost", "haulcast.vercel.app")
    assert config.allowed_origins == ("https://haulcast.vercel.app",)
    assert config.database_url == SESSION_URL
    assert config.database_url_pooled == POOLED_URL
    assert config.app_db_password == "app-secret-value"
    assert config.owner_db_password == "owner-secret-value"
    assert config.rate_limit_salt == SALT
    assert config.cron_secret == "cron-secret-value"
    assert config.client_ip_header == "x-real-ip"
    assert config.deployed is True
    assert config.commit == "0123456"
    assert config.truck_top_speed_kph == 95.0
    assert config.test_database_name == "test_haulcast_example"


@pytest.mark.parametrize("name", ["DATABASE_URL", "DATABASE_URL_POOLED", "CRON_SECRET"])
def test_config_treats_blank_optional_values_as_unset(name: str) -> None:
    config = Config.from_env({name: "  "})

    assert (config.database_url, config.database_url_pooled, config.cron_secret) == (
        None,
        None,
        None,
    )


UNIQUE_HOST = "haulcast-6fgn2rkj9-example-projects.vercel.app"
BRANCH_HOST = "haulcast-git-feature-example-projects.vercel.app"
PRODUCTION_HOST = "haulcast-example.vercel.app"
VERCEL_HOSTS_ENV = {
    "VERCEL": "1",
    "VERCEL_URL": UNIQUE_HOST,
    "VERCEL_BRANCH_URL": BRANCH_HOST,
    "VERCEL_PROJECT_PRODUCTION_URL": PRODUCTION_HOST,
}


def test_config_allows_the_hosts_vercel_assigned_to_the_deployment() -> None:
    config = Config.from_env({**VERCEL_HOSTS_ENV, "ALLOWED_HOSTS": "haulcast.example.com"})

    assert config.allowed_hosts == (
        "haulcast.example.com",
        UNIQUE_HOST,
        BRANCH_HOST,
        PRODUCTION_HOST,
    )


def test_config_allows_a_vercel_deployment_without_any_explicit_allowed_hosts() -> None:
    # A preview host is one DNS label under vercel.app that changes with every deployment, which
    # Django's host patterns (exact, leading-dot domain, "*") cannot list statically: the platform
    # names it, so ALLOWED_HOSTS may stay empty.
    config = Config.from_env({"VERCEL": "1", "VERCEL_URL": UNIQUE_HOST})

    assert config.allowed_hosts == (UNIQUE_HOST,)


def test_config_ignores_the_vercel_host_variables_when_not_running_on_vercel() -> None:
    environ = {k: v for k, v in VERCEL_HOSTS_ENV.items() if k != "VERCEL"}

    assert Config.from_env(environ).allowed_hosts == ()
    assert Config.from_env({**environ, "VERCEL": "0"}).allowed_hosts == ()


def test_config_does_not_repeat_a_vercel_host_that_is_already_listed() -> None:
    config = Config.from_env(
        {
            "VERCEL": "1",
            "VERCEL_URL": UNIQUE_HOST,
            "VERCEL_BRANCH_URL": UNIQUE_HOST.upper(),
            "VERCEL_PROJECT_PRODUCTION_URL": PRODUCTION_HOST.upper(),
            "ALLOWED_HOSTS": PRODUCTION_HOST,
        }
    )

    assert config.allowed_hosts == (PRODUCTION_HOST, UNIQUE_HOST)


def test_config_ignores_blank_vercel_host_variables() -> None:
    config = Config.from_env(
        {
            "VERCEL": "1",
            "VERCEL_URL": UNIQUE_HOST,
            "VERCEL_BRANCH_URL": "   ",
            "VERCEL_PROJECT_PRODUCTION_URL": "",
        }
    )

    assert config.allowed_hosts == (UNIQUE_HOST,)


@pytest.mark.parametrize(
    "raw",
    [
        f"https://{UNIQUE_HOST}",
        f".{UNIQUE_HOST}",
        "*",
        f"{UNIQUE_HOST}:8080",
        f"{UNIQUE_HOST}/path",
        "two words.vercel.app",
        "-leading-hyphen.vercel.app",
        "trailing-hyphen-.vercel.app",
        "no-dots",
        "empty..label.vercel.app",
        "x" * 64 + ".vercel.app",
        ".".join(["a" * 60] * 5) + ".com",
    ],
)
@pytest.mark.parametrize(
    "name", ["VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL"]
)
def test_config_rejects_a_vercel_host_that_is_not_a_bare_host_name(name: str, raw: str) -> None:
    with pytest.raises(ConfigError, match=name) as excinfo:
        Config.from_env({"VERCEL": "1", name: raw})

    assert raw not in str(excinfo.value)


def test_a_vercel_production_deployment_needs_no_explicit_allowed_hosts() -> None:
    environ = {**PRODUCTION_ENV, "ALLOWED_HOSTS": "", "VERCEL": "1", "VERCEL_URL": UNIQUE_HOST}

    assert Config.from_env(environ).production_problems() == ()


@pytest.mark.parametrize(
    ("environ", "expected"),
    [
        ({"VERCEL_ENV": "production"}, True),
        ({"VERCEL_ENV": "preview"}, True),
        ({"VERCEL_ENV": "development"}, False),
        ({"HAULCAST_ENV": "production"}, True),
        ({"HAULCAST_ENV": "staging"}, False),
        ({}, False),
    ],
)
def test_config_is_deployed_on_vercel_production_and_preview_or_by_haulcast_env(
    environ: dict[str, str], *, expected: bool
) -> None:
    assert Config.from_env(environ).deployed is expected


@pytest.mark.parametrize(
    ("environ", "expected"),
    [
        ({"CLIENT_IP_HEADER": "CF-Connecting-IP"}, "cf-connecting-ip"),
        ({"VERCEL": "1"}, "x-forwarded-for"),
        ({"VERCEL": "1", "CLIENT_IP_HEADER": "X-Real-IP"}, "x-real-ip"),
        ({"VERCEL": "false"}, None),
        ({}, None),
    ],
)
def test_config_trusts_a_client_ip_header_only_when_configured_or_on_vercel(
    environ: dict[str, str], expected: str | None
) -> None:
    assert Config.from_env(environ).client_ip_header == expected


@pytest.mark.parametrize("header", ["X Real IP", "X-Real-IP:", "x_real_ip", "ip\r\nx: y"])
def test_config_rejects_a_client_ip_header_that_is_not_a_plain_header_name(header: str) -> None:
    with pytest.raises(ConfigError, match="CLIENT_IP_HEADER"):
        Config.from_env({"CLIENT_IP_HEADER": header})


def test_config_rejects_a_malformed_debug_flag() -> None:
    with pytest.raises(ConfigError, match="DEBUG"):
        Config.from_env({"DEBUG": "sometimes"})


@pytest.mark.parametrize("raw", ["fast", "10", "500"])
def test_config_rejects_a_truck_speed_that_is_not_a_plausible_number(raw: str) -> None:
    with pytest.raises(ConfigError, match="TRUCK_TOP_SPEED_KPH"):
        Config.from_env({"TRUCK_TOP_SPEED_KPH": raw})


@pytest.mark.parametrize(
    ("environ", "expected"),
    [
        ({"COMMIT_SHA": "abc1234def"}, "abc1234"),
        ({"VERCEL_GIT_COMMIT_SHA": "FEDCBA9876"}, "fedcba9"),
        ({"COMMIT_SHA": " ", "VERCEL_GIT_COMMIT_SHA": "1234567"}, "1234567"),
        ({"COMMIT_SHA": "aaaaaaa", "VERCEL_GIT_COMMIT_SHA": "bbbbbbb"}, "aaaaaaa"),
        ({}, UNKNOWN_COMMIT),
    ],
)
def test_config_commit_prefers_commit_sha_then_vercel_then_unknown(
    environ: dict[str, str], expected: str
) -> None:
    assert Config.from_env(environ).commit == expected


@pytest.mark.parametrize(
    ("environ", "variable"),
    [
        ({"COMMIT_SHA": "xyz"}, "COMMIT_SHA"),
        ({"COMMIT_SHA": "abc12"}, "COMMIT_SHA"),
        ({"VERCEL_GIT_COMMIT_SHA": "not-a-sha-at-all"}, "VERCEL_GIT_COMMIT_SHA"),
        ({"COMMIT_SHA": "a" * 41}, "COMMIT_SHA"),
    ],
)
def test_config_rejects_commits_that_are_not_hex_shas(
    environ: dict[str, str], variable: str
) -> None:
    with pytest.raises(ConfigError, match=variable):
        Config.from_env(environ)


# --------------------------------------------------------------------------- production rules


def test_a_complete_production_environment_has_no_problems() -> None:
    config = Config.from_env(PRODUCTION_ENV)

    assert config.production_problems() == ()
    config.validate()


@pytest.mark.parametrize(
    ("override", "fragment"),
    [
        ({"DEBUG": "1"}, "DEBUG must be off"),
        ({"DJANGO_SECRET_KEY": "short"}, "DJANGO_SECRET_KEY must be at least 50 characters"),
        ({"DJANGO_SECRET_KEY": ""}, "DJANGO_SECRET_KEY"),
        ({"ALLOWED_HOSTS": ""}, "ALLOWED_HOSTS must list at least one host"),
        ({"RATE_LIMIT_SALT": "short"}, "RATE_LIMIT_SALT must be at least 16 characters"),
        ({"DATABASE_URL_POOLED": ""}, "DATABASE_URL_POOLED (or DATABASE_URL) is required"),
        ({"HAULCAST_APP_DB_PASSWORD": ""}, "HAULCAST_APP_DB_PASSWORD is required"),
        ({"CRON_SECRET": "short-secret"}, "CRON_SECRET must be at least 32 characters when set"),
    ],
)
def test_each_production_gap_is_reported_by_variable_name(
    override: dict[str, str], fragment: str
) -> None:
    config = Config.from_env(PRODUCTION_ENV | override)

    assert any(fragment in problem for problem in config.production_problems())
    with pytest.raises(ConfigError, match="invalid production configuration"):
        config.validate()


@pytest.mark.parametrize(("length", "accepted"), [(31, False), (32, True), (43, True)])
def test_a_cron_secret_needs_32_characters_in_a_deployed_environment(
    length: int, *, accepted: bool
) -> None:
    """R2-13: Vercel recommends 16 or more random characters; guessing is capped only per IP."""
    config = Config.from_env(PRODUCTION_ENV | {"CRON_SECRET": "c" * length})

    assert (config.production_problems() == ()) is accepted


def test_an_unset_cron_secret_is_no_production_problem() -> None:
    """Without the secret the maintenance endpoint is simply invisible (404)."""
    assert "CRON_SECRET" not in PRODUCTION_ENV
    assert Config.from_env(PRODUCTION_ENV).production_problems() == ()


def test_database_url_alone_satisfies_the_production_database_requirement() -> None:
    environ = {k: v for k, v in PRODUCTION_ENV.items() if k != "DATABASE_URL_POOLED"}

    assert Config.from_env({**environ, "DATABASE_URL": SESSION_URL}).production_problems() == ()


def test_validation_lists_every_gap_but_never_a_secret_value() -> None:
    secret = "do-not-leak-" + "this"
    config = Config.from_env({"VERCEL_ENV": "production", "CRON_SECRET": secret, "DEBUG": "1"})

    with pytest.raises(ConfigError) as excinfo:
        config.validate()

    message = str(excinfo.value)
    assert secret not in message
    for variable in ("DEBUG", "DJANGO_SECRET_KEY", "ALLOWED_HOSTS", "RATE_LIMIT_SALT"):
        assert variable in message


def test_a_local_environment_is_never_refused_for_missing_production_settings() -> None:
    config = Config.from_env({})

    assert config.production_problems() != ()
    config.validate()


# --------------------------------------------------------------------------- startup warnings


def test_a_vercel_production_deployment_without_listed_hosts_is_warned_at_startup() -> None:
    """R2-42: the platform's own hosts pass the production check, a custom domain would not pass."""
    environ = {k: v for k, v in PRODUCTION_ENV.items() if k != "ALLOWED_HOSTS"}

    warnings = startup_warnings(environ)

    assert len(warnings) == 1
    assert "ALLOWED_HOSTS" in warnings[0]
    assert "400" in warnings[0]


@pytest.mark.parametrize(
    "environ",
    [
        pytest.param(PRODUCTION_ENV, id="production-with-a-listed-host"),
        pytest.param({"VERCEL_ENV": "preview"}, id="preview-without-hosts"),
        pytest.param({"HAULCAST_ENV": "production"}, id="not-on-vercel"),
        pytest.param({}, id="local"),
    ],
)
def test_every_other_environment_starts_without_a_warning(environ: dict[str, str]) -> None:
    assert startup_warnings(environ) == ()


# --------------------------------------------------------------------------- replay mode

REPLAY_NOW = "2026-10-20T13:40:00Z"
REPLAY_ENV = {"HAULCAST_PROVIDER_MODE": "replay", "HAULCAST_REPLAY_NOW": REPLAY_NOW}
DEPLOYMENTS = (
    pytest.param({"VERCEL_ENV": "production"}, id="vercel-production"),
    pytest.param({"VERCEL_ENV": "preview"}, id="vercel-preview"),
    pytest.param({"HAULCAST_ENV": "production"}, id="haulcast-env-production"),
)


def _deployed(deployment: dict[str, str]) -> dict[str, str]:
    """A complete, valid production environment of the given kind (no replay)."""
    base = {name: value for name, value in PRODUCTION_ENV.items() if name != "VERCEL_ENV"}
    return {**base, **deployment}


def test_provider_mode_is_live_unless_replay_is_asked_for() -> None:
    assert Config.from_env({}).provider_mode is ProviderMode.LIVE
    assert Config.from_env({"HAULCAST_PROVIDER_MODE": "  "}).provider_mode is ProviderMode.LIVE
    assert Config.from_env({"HAULCAST_PROVIDER_MODE": "live"}).provider_mode is ProviderMode.LIVE


@pytest.mark.parametrize("raw", ["replay", "REPLAY", " Replay\n"])
def test_replay_is_selected_by_name_whatever_the_case(raw: str) -> None:
    config = Config.from_env({**REPLAY_ENV, "HAULCAST_PROVIDER_MODE": raw})

    assert config.provider_mode is ProviderMode.REPLAY


@pytest.mark.parametrize("raw", ["record", "mock", "replayed", "1", "true", "live,replay"])
def test_any_other_provider_mode_is_refused_naming_the_variable(raw: str) -> None:
    with pytest.raises(ConfigError, match="HAULCAST_PROVIDER_MODE"):
        Config.from_env({"HAULCAST_PROVIDER_MODE": raw})


@pytest.mark.parametrize(
    "environ",
    [
        pytest.param({"HAULCAST_PROVIDER_MODE": "replay"}, id="unset"),
        pytest.param({"HAULCAST_PROVIDER_MODE": "replay", "HAULCAST_REPLAY_NOW": ""}, id="empty"),
        pytest.param({"HAULCAST_PROVIDER_MODE": "replay", "HAULCAST_REPLAY_NOW": " "}, id="blank"),
    ],
)
def test_replay_mode_without_a_clock_is_refused_naming_the_variable(
    environ: dict[str, str],
) -> None:
    """There is no default date: a baked-in instant would age out of the departure window."""
    with pytest.raises(ConfigError, match="HAULCAST_REPLAY_NOW"):
        Config.from_env(environ)


@pytest.mark.parametrize(
    "raw",
    ["yesterday", "2026-13-40T00:00:00Z", "2026-10-20T13:40:00", "2026-10-20", "1792000000"],
)
def test_the_replay_clock_must_be_an_iso_instant_with_an_offset(raw: str) -> None:
    with pytest.raises(ConfigError, match="HAULCAST_REPLAY_NOW"):
        Config.from_env({**REPLAY_ENV, "HAULCAST_REPLAY_NOW": raw})


def test_the_replay_clock_is_read_as_one_utc_instant() -> None:
    zulu = Config.from_env(REPLAY_ENV).replay_now
    offset = Config.from_env(
        {**REPLAY_ENV, "HAULCAST_REPLAY_NOW": "2026-10-20T18:40:00+05:00"}
    ).replay_now

    assert zulu == datetime(2026, 10, 20, 13, 40, tzinfo=UTC)
    assert offset == zulu
    assert offset is not None
    assert offset.utcoffset() == timedelta(0)


def test_live_mode_has_no_replay_clock_and_does_not_read_one() -> None:
    assert Config.from_env({}).replay_now is None
    assert Config.from_env({"HAULCAST_REPLAY_NOW": "not a date"}).replay_now is None


def test_the_replay_catalog_defaults_to_the_recorded_provider_fixtures() -> None:
    directory = Config.from_env(REPLAY_ENV).replay_dir

    assert directory == default_replay_dir()
    assert directory.parts[-4:] == ("backend", "tests", "fixtures", "providers")
    assert directory.is_dir()


def test_the_replay_catalog_directory_can_be_chosen(tmp_path: Path) -> None:
    config = Config.from_env({**REPLAY_ENV, "HAULCAST_REPLAY_DIR": f" {tmp_path} "})

    assert config.replay_dir == tmp_path


@pytest.mark.parametrize("deployment", DEPLOYMENTS)
def test_replay_mode_is_refused_in_a_deployed_environment(deployment: dict[str, str]) -> None:
    deployed = _deployed(deployment)
    Config.from_env(deployed).validate()  # the twin: nothing else is wrong with this environment

    config = Config.from_env({**deployed, **REPLAY_ENV})

    assert any("HAULCAST_PROVIDER_MODE" in problem for problem in config.production_problems())
    with pytest.raises(ConfigError, match="HAULCAST_PROVIDER_MODE"):
        config.validate()


def test_replay_mode_is_the_only_production_problem_of_an_otherwise_valid_deployment() -> None:
    config = Config.from_env({**PRODUCTION_ENV, **REPLAY_ENV})

    assert len(config.production_problems()) == 1


def test_replay_mode_needs_its_catalog_directory_at_startup(tmp_path: Path) -> None:
    missing = tmp_path / "no-such-catalog"
    config = Config.from_env({**REPLAY_ENV, "HAULCAST_REPLAY_DIR": str(missing)})

    with pytest.raises(ConfigError, match="HAULCAST_REPLAY_DIR") as excinfo:
        config.validate()

    assert str(missing) in str(excinfo.value)
    Config.from_env({**REPLAY_ENV, "HAULCAST_REPLAY_DIR": str(tmp_path)}).validate()


def test_live_mode_ignores_the_replay_directory(tmp_path: Path) -> None:
    Config.from_env({"HAULCAST_REPLAY_DIR": str(tmp_path / "no-such-catalog")}).validate()


@pytest.mark.parametrize("raw", ["replay", "REPLAY"])
def test_replay_mode_is_announced_at_startup(raw: str) -> None:
    warnings = startup_warnings({**REPLAY_ENV, "HAULCAST_PROVIDER_MODE": raw})

    assert len(warnings) == 1
    assert "HAULCAST_PROVIDER_MODE" in warnings[0]
    assert "recorded" in warnings[0]


def test_live_mode_is_not_announced_at_startup() -> None:
    assert startup_warnings({"HAULCAST_PROVIDER_MODE": "live"}) == ()


# --------------------------------------------------------------------------- django_databases


def test_runtime_connects_as_the_app_role_through_the_pooler_and_migrations_as_the_owner() -> None:
    config = Config.from_env(
        {
            "DATABASE_URL": SESSION_URL,
            "DATABASE_URL_POOLED": POOLED_URL,
            "HAULCAST_APP_DB_PASSWORD": "app-secret-value",
            "HAULCAST_OWNER_DB_PASSWORD": "owner-secret-value",
        }
    )

    databases = config.django_databases()

    assert set(databases) == {"default", "owner"}
    assert databases["default"]["USER"] == f"{APP_ROLE}.{TENANT}"
    assert databases["default"]["PORT"] == 6543
    assert databases["default"]["PASSWORD"] == "app-secret-value"
    assert databases["default"]["DISABLE_SERVER_SIDE_CURSORS"] is True
    assert databases["owner"]["USER"] == f"{OWNER_ROLE}.{TENANT}"
    assert databases["owner"]["PORT"] == 5432
    assert databases["owner"]["PASSWORD"] == "owner-secret-value"
    assert "TEST" not in databases["default"]


def test_a_single_url_serves_both_roles() -> None:
    config = Config.from_env(
        {
            "DATABASE_URL": "postgresql://postgres@127.0.0.1:54329/haulcast",
            "HAULCAST_TEST_DB_NAME": "test_haulcast_example",
        }
    )

    databases = config.django_databases()

    assert databases["default"]["USER"] == APP_ROLE
    assert databases["owner"]["USER"] == OWNER_ROLE
    assert databases["default"]["TEST"] == {"NAME": "test_haulcast_example"}


def test_only_the_pooled_url_still_yields_an_owner_entry_on_the_same_server() -> None:
    config = Config.from_env({"DATABASE_URL_POOLED": POOLED_URL})

    assert config.django_databases()["owner"]["PORT"] == 6543
