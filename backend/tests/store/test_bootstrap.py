"""Behaviour of ``haulcast.store.bootstrap``: roles, ownership, privileges, idempotency, the CLI.

Most tests run against a scratch database with throw-away role names (roles are cluster-wide), so
they can observe the first run (``created``) as well as re-runs. One test runs the bootstrap as a
*non-superuser* admin, which is what the Supabase ``postgres`` role is.
"""

import secrets
from collections.abc import Iterator
from contextlib import closing, contextmanager

import psycopg
import pytest
from django.conf import settings
from psycopg import errors, sql

from haulcast.store import bootstrap as bootstrap_module
from haulcast.store.bootstrap import (
    BootstrapError,
    BootstrapNames,
    BootstrapPasswords,
    bootstrap,
    main,
)
from tests.dbtools import Connection, connect, drop_roles, scratch_database, throwaway_names

pytestmark = pytest.mark.django_db(databases=["default"])


def _passwords() -> BootstrapPasswords:
    return BootstrapPasswords(owner=secrets.token_urlsafe(24), app=secrets.token_urlsafe(24))


@pytest.fixture
def fresh() -> Iterator[tuple[str, BootstrapNames, Connection]]:
    """A scratch database, throw-away names and an admin connection to it; cleaned up after."""
    names = throwaway_names()
    with scratch_database("t5a_boot") as database, connect("default", database) as admin:
        yield database, names, admin
        admin.close()
        # The database goes away in scratch_database's cleanup; roles are dropped after it.
    drop_roles(names.owner, names.app, *names.api_roles)


def test_first_run_creates_roles_and_schema_and_second_run_converges(
    fresh: tuple[str, BootstrapNames, Connection],
) -> None:
    _, names, admin = fresh
    passwords = _passwords()

    first = bootstrap(admin, passwords, names)
    second = bootstrap(admin, passwords, names)

    assert first.created_roles == (names.owner, names.app)
    assert first.existing_roles == ()
    assert second.created_roles == ()
    assert second.existing_roles == (names.owner, names.app)
    assert first.pg_cron_ready is False
    with closing(admin.cursor()) as cursor:
        cursor.execute(
            "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = %s", [names.schema]
        )
        assert cursor.fetchone() == (names.owner,)


def test_roles_are_plain_logins_with_the_schema_as_search_path(
    fresh: tuple[str, BootstrapNames, Connection],
) -> None:
    _, names, admin = fresh
    bootstrap(admin, _passwords(), names)

    rows = admin.execute(
        "SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, "
        "rolbypassrls, rolconfig FROM pg_roles WHERE rolname = ANY(%s) ORDER BY rolname",
        [[names.owner, names.app]],
    ).fetchall()

    assert len(rows) == 2
    for _, can_login, *elevated, config in rows:
        assert can_login is True
        assert elevated == [False, False, False, False, False]
        assert config == [f"search_path={names.schema}"]


def test_passwords_are_stored_as_scram_verifiers_never_plaintext(
    fresh: tuple[str, BootstrapNames, Connection],
) -> None:
    _, names, admin = fresh
    passwords = _passwords()
    bootstrap(admin, passwords, names)

    stored = admin.execute(
        "SELECT rolpassword FROM pg_authid WHERE rolname = %s", [names.app]
    ).fetchone()

    assert stored is not None
    assert str(stored[0]).startswith("SCRAM-SHA-256$")
    assert passwords.app not in str(stored[0])


def test_runtime_role_gets_dml_by_default_privileges_and_nothing_else(
    fresh: tuple[str, BootstrapNames, Connection],
) -> None:
    database, names, admin = fresh
    bootstrap(admin, _passwords(), names)
    stranger = f"t5a_stranger_{secrets.token_hex(4)}"
    admin.execute(sql.SQL("CREATE ROLE {} LOGIN").format(sql.Identifier(stranger)))
    try:
        with connect("default", database, user=names.owner) as owner:
            owner.execute(
                sql.SQL("CREATE TABLE {}.things (id int PRIMARY KEY, name text)").format(
                    sql.Identifier(names.schema)
                )
            )
        with connect("default", database, user=names.app) as app:
            table = sql.SQL("{}.things").format(sql.Identifier(names.schema))
            app.execute(sql.SQL("INSERT INTO {} VALUES (1, 'a')").format(table))
            app.execute(sql.SQL("UPDATE {} SET name = 'b'").format(table))
            assert app.execute(sql.SQL("SELECT name FROM {}").format(table)).fetchall() == [("b",)]
            app.execute(sql.SQL("DELETE FROM {}").format(table))
            for statement in (
                "TRUNCATE {}",
                "ALTER TABLE {} ADD COLUMN extra int",
                "DROP TABLE {}",
            ):
                with pytest.raises(errors.InsufficientPrivilege):
                    app.execute(sql.SQL(statement).format(table))
            with pytest.raises(errors.InsufficientPrivilege):
                app.execute(
                    sql.SQL("CREATE TABLE {}.other (i int)").format(sql.Identifier(names.schema))
                )
        with (
            connect("default", database, user=stranger) as outsider,
            pytest.raises(errors.InsufficientPrivilege),
        ):
            outsider.execute(
                sql.SQL("SELECT 1 FROM {}.things").format(sql.Identifier(names.schema))
            )
    finally:
        admin.close()
        drop_roles(stranger)


def test_new_functions_are_executable_by_the_runtime_role_only(
    fresh: tuple[str, BootstrapNames, Connection],
) -> None:
    database, names, admin = fresh
    bootstrap(admin, _passwords(), names)
    with connect("default", database, user=names.owner) as owner:
        owner.execute(
            sql.SQL("CREATE FUNCTION {}.answer() RETURNS int LANGUAGE sql AS 'SELECT 42'").format(
                sql.Identifier(names.schema)
            )
        )
    signature = f"{names.schema}.answer()"

    def can_execute(role: str) -> bool:
        row = admin.execute(
            "SELECT has_function_privilege(%s, %s, 'EXECUTE')", [role, signature]
        ).fetchone()
        assert row is not None
        return row[0] is True

    assert can_execute(names.app) is True
    assert can_execute("public") is False


def test_api_roles_lose_access_even_when_they_held_it_before(
    fresh: tuple[str, BootstrapNames, Connection],
) -> None:
    _, names, admin = fresh
    bootstrap(admin, _passwords(), names)
    anon = names.api_roles[0]
    admin.execute(sql.SQL("CREATE ROLE {}").format(sql.Identifier(anon)))
    admin.execute(
        sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(
            sql.Identifier(names.schema), sql.Identifier(anon)
        )
    )

    bootstrap(admin, _passwords(), names)

    row = admin.execute("SELECT has_schema_privilege(%s, %s, 'USAGE')", [anon, names.schema])
    assert row.fetchone() == (False,)


def test_pg_cron_access_is_granted_to_the_owner_when_the_extension_exists(
    fresh: tuple[str, BootstrapNames, Connection],
) -> None:
    _, names, admin = fresh
    admin.execute("CREATE SCHEMA cron")
    admin.execute("CREATE TABLE cron.job (jobid bigint, jobname text)")
    admin.execute(
        "CREATE FUNCTION cron.schedule(a text, b text, c text) RETURNS bigint "
        "LANGUAGE sql AS 'SELECT 1::bigint'"
    )
    admin.execute(
        "CREATE FUNCTION cron.unschedule(a text) RETURNS boolean LANGUAGE sql AS 'SELECT true'"
    )
    admin.execute("REVOKE EXECUTE ON FUNCTION cron.schedule(text, text, text) FROM PUBLIC")

    report = bootstrap(admin, _passwords(), names)

    assert report.pg_cron_ready is True


@contextmanager
def _non_superuser_admin(admin: Connection, database: str) -> Iterator[Connection]:
    """A connection of a role with CREATEROLE but no superuser rights, like Supabase's postgres."""
    delegate = f"t5a_admin_{secrets.token_hex(4)}"
    admin.execute(sql.SQL("CREATE ROLE {} LOGIN CREATEROLE").format(sql.Identifier(delegate)))
    admin.execute(
        sql.SQL("GRANT CREATE ON DATABASE {} TO {}").format(
            sql.Identifier(database), sql.Identifier(delegate)
        )
    )
    try:
        with connect("default", database, user=delegate) as delegated:
            yield delegated
    finally:
        admin.execute(
            sql.SQL("REVOKE CREATE ON DATABASE {} FROM {}").format(
                sql.Identifier(database), sql.Identifier(delegate)
            )
        )
        admin.close()
        drop_roles(delegate)


def test_bootstrap_works_for_a_non_superuser_admin_like_supabase_postgres(
    fresh: tuple[str, BootstrapNames, Connection],
) -> None:
    database, names, admin = fresh

    with _non_superuser_admin(admin, database) as delegated:
        first = bootstrap(delegated, _passwords(), names)
        # Every production deploy runs the bootstrap again. PostgreSQL 16+ refuses a non-superuser
        # even the clause `ALTER ROLE ... NOSUPERUSER`, so the re-run must not state attributes
        # that are already right.
        second = bootstrap(delegated, _passwords(), names)

    assert first.created_roles == (names.owner, names.app)
    assert second.created_roles == ()
    assert second.existing_roles == (names.owner, names.app)


def test_a_re_run_restores_the_attributes_a_role_was_elevated_with(
    fresh: tuple[str, BootstrapNames, Connection],
) -> None:
    _, names, admin = fresh
    bootstrap(admin, _passwords(), names)
    for role in (names.owner, names.app):
        admin.execute(
            sql.SQL(
                "ALTER ROLE {} WITH SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS NOLOGIN"
            ).format(sql.Identifier(role))
        )

    bootstrap(admin, _passwords(), names)

    rows = admin.execute(
        "SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, "
        "rolbypassrls FROM pg_roles WHERE rolname = ANY(%s) ORDER BY rolname",
        [[names.owner, names.app]],
    ).fetchall()
    assert len(rows) == 2
    for _, can_login, *elevated in rows:
        assert can_login is True
        assert elevated == [False, False, False, False, False]


def test_a_deviation_the_admin_may_not_repair_fails_the_run_and_changes_nothing(
    fresh: tuple[str, BootstrapNames, Connection],
) -> None:
    database, names, admin = fresh
    bootstrap(admin, _passwords(), names)
    admin.execute(sql.SQL("ALTER ROLE {} WITH SUPERUSER").format(sql.Identifier(names.owner)))
    stored = "SELECT rolpassword FROM pg_authid WHERE rolname = %s"
    password_before = admin.execute(stored, [names.app]).fetchone()

    with (
        _non_superuser_admin(admin, database) as delegated,
        pytest.raises(errors.InsufficientPrivilege),
    ):
        bootstrap(delegated, _passwords(), names)

    with connect("default", database) as check:
        owner = check.execute("SELECT rolsuper FROM pg_roles WHERE rolname = %s", [names.owner])
        assert owner.fetchone() == (True,)
        assert check.execute(stored, [names.app]).fetchone() == password_before


def test_a_failed_verification_rolls_everything_back(
    fresh: tuple[str, BootstrapNames, Connection], monkeypatch: pytest.MonkeyPatch
) -> None:
    _, names, admin = fresh
    monkeypatch.setattr(
        bootstrap_module,
        "_checks",
        lambda _names: (("a deliberately failing check", sql.SQL("SELECT false"), ()),),
    )

    with pytest.raises(BootstrapError, match="verification failed: a deliberately failing check"):
        bootstrap(admin, _passwords(), names)

    row = admin.execute(
        "SELECT count(*) FROM pg_roles WHERE rolname = ANY(%s)", [[names.owner, names.app]]
    )
    assert row.fetchone() == (0,)


@pytest.mark.parametrize("weak", ["", "short", "x" * 15])
def test_weak_passwords_are_refused(weak: str) -> None:
    with pytest.raises(BootstrapError, match="owner role password"):
        BootstrapPasswords(owner=weak, app=secrets.token_urlsafe(24))
    with pytest.raises(BootstrapError, match="app role password"):
        BootstrapPasswords(owner=secrets.token_urlsafe(24), app=weak)


# --------------------------------------------------------------------------- command line


def _database_url(database: str) -> str:
    entry = settings.DATABASES["default"]
    return f"postgresql://{entry['USER']}@{entry['HOST']}:{entry['PORT']}/{database}"


def test_main_bootstraps_the_database_named_by_the_environment(
    fresh: tuple[str, BootstrapNames, Connection], capsys: pytest.CaptureFixture[str]
) -> None:
    database, _, _ = fresh
    environ = {
        "DATABASE_URL": _database_url(database),
        "HAULCAST_OWNER_DB_PASSWORD": settings.DATABASES["owner"]["PASSWORD"],
        "HAULCAST_APP_DB_PASSWORD": settings.DATABASES["app"]["PASSWORD"],
    }

    assert main([], environ) == 0

    output = capsys.readouterr().out
    assert "created roles:" in output
    assert "pg_cron cleanup scheduling available: no" in output
    assert environ["HAULCAST_APP_DB_PASSWORD"] not in output


@pytest.mark.parametrize(
    ("environ", "expected"),
    [
        ({}, "DATABASE_URL is required"),
        ({"DATABASE_URL": "mysql://u@h/db"}, "scheme"),
        (
            {
                "DATABASE_URL": "postgresql://u@127.0.0.1:1/db",
                "HAULCAST_OWNER_DB_PASSWORD": "x" * 20,
            },
            "HAULCAST_APP_DB_PASSWORD is required",
        ),
        (
            {
                "DATABASE_URL": "postgresql://u@127.0.0.1:1/db",
                "HAULCAST_OWNER_DB_PASSWORD": "short",
                "HAULCAST_APP_DB_PASSWORD": "x" * 20,
            },
            "owner role password",
        ),
    ],
)
def test_main_reports_problems_on_stderr_and_fails(
    environ: dict[str, str], expected: str, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main([], environ) == 1

    captured = capsys.readouterr()
    assert expected in captured.err
    assert captured.out == ""


def test_main_reports_a_database_that_cannot_be_reached_without_echoing_secrets(
    capsys: pytest.CaptureFixture[str],
) -> None:
    secret = secrets.token_urlsafe(24)
    environ = {
        "DATABASE_URL": _database_url("t5a_no_such_database"),
        "HAULCAST_OWNER_DB_PASSWORD": secret,
        "HAULCAST_APP_DB_PASSWORD": secrets.token_urlsafe(24),
    }

    assert main([], environ) == 1

    captured = capsys.readouterr()
    assert "bootstrap_db failed: OperationalError" in captured.err
    assert 't5a_no_such_database" does not exist' in captured.err
    assert secret not in captured.err
    assert captured.out == ""


def test_main_prints_help_without_touching_the_database(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as excinfo:
        main(["--help"], {})

    assert excinfo.value.code == 0
    assert "bootstrap_db" in capsys.readouterr().out


def test_bootstrap_error_is_a_runtime_error_and_psycopg_errors_stay_distinct() -> None:
    assert issubclass(BootstrapError, RuntimeError)
    assert not issubclass(BootstrapError, psycopg.Error)
