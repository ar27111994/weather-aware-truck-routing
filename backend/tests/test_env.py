"""Unit tests for the typed environment parsing in ``haulcast.config.env``."""

import pytest
from hypothesis import given
from hypothesis import strategies as st

from haulcast.config.env import (
    UNKNOWN_COMMIT,
    Config,
    ConfigError,
    database_from_url,
    env_bool,
    env_csv,
)

SUPABASE_URL = (
    "postgresql://postgres.abcdefghijklmnopqrst:p%40ss%3Aword"
    "@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require"
)


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


# --------------------------------------------------------------------------- database_from_url


def test_database_from_url_maps_a_supabase_pooler_url() -> None:
    assert database_from_url(SUPABASE_URL) == {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": "postgres",
        "USER": "postgres.abcdefghijklmnopqrst",
        "PASSWORD": "p@ss:word",
        "HOST": "aws-0-us-east-1.pooler.supabase.com",
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
        ("mysql://u:p@h/db", "scheme"),
        ("postgresql:///db", "no host"),
        ("postgresql://u:p@h", "no database name"),
        ("postgresql://u:p@h/", "no database name"),
        ("postgresql://u:p@h:notaport/db", "invalid port"),
        ("postgresql://u:p@h:70000/db", "invalid port"),
        ("postgresql://u:p@h/db?connect_timeout=3&application_name=x", "application_name, connect"),
        ("postgresql://u:p@h/db?sslmode=maybe", "invalid sslmode"),
    ],
)
def test_database_from_url_rejects_malformed_urls(url: str, message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        database_from_url(url)


def test_database_error_messages_never_echo_the_url_or_its_password() -> None:
    with pytest.raises(ConfigError) as excinfo:
        database_from_url("mysql://admin:hunter2-secret@db.internal/appdb")
    assert "hunter2-secret" not in str(excinfo.value)
    assert "db.internal" not in str(excinfo.value)


# --------------------------------------------------------------------------- Config


def test_config_defaults_are_fail_closed() -> None:
    config = Config.from_env({})
    assert config.debug is False
    assert config.secret_key == ""
    assert config.allowed_hosts == ()
    assert config.database_url is None
    assert config.commit == UNKNOWN_COMMIT
    assert config.django_databases() == {}


def test_config_parses_every_variable() -> None:
    django_key = "env-provided-signing-value"
    config = Config.from_env(
        {
            "DEBUG": "true",
            "DJANGO_SECRET_KEY": django_key,
            "ALLOWED_HOSTS": "localhost, haulcast.vercel.app",
            "DATABASE_URL": SUPABASE_URL,
            "COMMIT_SHA": "0123456789ABCDEF",
        }
    )
    assert config.debug is True
    assert config.secret_key == django_key
    assert config.allowed_hosts == ("localhost", "haulcast.vercel.app")
    assert config.commit == "0123456"
    assert config.django_databases() == {"default": database_from_url(SUPABASE_URL)}


def test_config_treats_a_blank_database_url_as_unset() -> None:
    assert Config.from_env({"DATABASE_URL": "  "}).database_url is None


def test_config_rejects_a_malformed_debug_flag() -> None:
    with pytest.raises(ConfigError, match="DEBUG"):
        Config.from_env({"DEBUG": "sometimes"})


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
