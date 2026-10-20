"""The migrated schema: ownership, indexes, row level security and the runtime role's powers.

Everything is observed from outside the code under test: catalog queries as the superuser and real
statements as ``haulcast_app`` / a stranger, so these tests prove what the database enforces, not
what the Python believes.
"""

import secrets
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from django.core.management import call_command
from psycopg import errors, sql

from haulcast.store.models import (
    GeocodeCache,
    Plan,
    RateLimitBucket,
    RouteCache,
    UpstreamBudget,
    WeatherCache,
)
from tests.dbtools import Connection, connect, drop_roles

TTL_TABLES = (
    "geocode_cache",
    "route_cache",
    "weather_cache",
    "plan",
    "rate_limit_bucket",
    "upstream_budget",
)
FAR_FUTURE = datetime(2999, 1, 1, tzinfo=UTC)


@pytest.fixture
def clean_tables(admin_connection: Connection) -> Iterator[None]:
    """Empty the application tables around a test that writes through autocommit connections."""

    def truncate() -> None:
        admin_connection.execute("TRUNCATE " + ", ".join(f"app.{table}" for table in TTL_TABLES))

    truncate()
    yield
    truncate()


# --------------------------------------------------------------------------- structure


def test_every_table_belongs_to_the_owner_role_in_schema_app(admin_connection: Connection) -> None:
    rows = admin_connection.execute(
        "SELECT c.relname, pg_get_userbyid(c.relowner) FROM pg_class c "
        "JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = 'app' AND c.relkind = 'r' ORDER BY 1"
    ).fetchall()

    assert [name for name, _ in rows] == sorted([*TTL_TABLES, "django_migrations"])
    assert {owner for _, owner in rows} == {"haulcast_owner"}


def test_no_table_leaks_into_the_public_schema(admin_connection: Connection) -> None:
    row = admin_connection.execute(
        "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"
    ).fetchone()

    assert row == (0,)


def _names(value: object) -> tuple[str, ...]:
    """Narrow an ``array_agg`` result (psycopg returns a list) to a tuple of strings."""
    assert isinstance(value, list)
    return tuple(str(item) for item in value)


def _indexes(connection: Connection) -> set[tuple[str, bool, tuple[str, ...]]]:
    rows = connection.execute(
        "SELECT t.relname, i.indisunique, array_agg(a.attname ORDER BY k.ord) "
        "FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid "
        "JOIN pg_namespace n ON n.oid = t.relnamespace "
        "JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true "
        "JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum "
        "WHERE n.nspname = 'app' GROUP BY t.relname, i.indexrelid, i.indisunique"
    ).fetchall()
    return {(str(table), bool(unique), _names(columns)) for table, unique, columns in rows}


@pytest.mark.parametrize(
    ("table", "columns"),
    [
        ("geocode_cache", ("key",)),
        ("route_cache", ("key",)),
        ("weather_cache", ("location_key", "model", "variables_hash", "window_start")),
        ("plan", ("id",)),
        ("rate_limit_bucket", ("key",)),
        ("upstream_budget", ("key",)),
    ],
)
def test_every_lookup_key_is_unique(
    admin_connection: Connection, table: str, columns: tuple[str, ...]
) -> None:
    assert (table, True, columns) in _indexes(admin_connection)


@pytest.mark.parametrize("table", TTL_TABLES)
def test_every_ttl_table_has_an_expires_at_index(admin_connection: Connection, table: str) -> None:
    assert (table, False, ("expires_at",)) in _indexes(admin_connection)


def test_plans_are_indexed_by_request_hash_and_creation_time(admin_connection: Connection) -> None:
    assert ("plan", False, ("request_hash", "created_at")) in _indexes(admin_connection)


# --------------------------------------------------------------------------- row level security


def test_every_table_has_row_level_security_and_a_policy_for_the_runtime_role_only(
    admin_connection: Connection,
) -> None:
    rows = admin_connection.execute(
        "SELECT c.relname, c.relrowsecurity, "
        "coalesce((SELECT array_agg(p.polname || ':' || "
        "  (SELECT string_agg(r.rolname, ',') FROM pg_roles r WHERE r.oid = ANY(p.polroles))) "
        "  FROM pg_policy p WHERE p.polrelid = c.oid), '{}') "
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = 'app' AND c.relkind = 'r' ORDER BY 1"
    ).fetchall()

    by_table = {name: (secured, policies) for name, secured, policies in rows}
    assert all(secured for secured, _ in by_table.values())
    for table in TTL_TABLES:
        assert by_table[table][1] == ["haulcast_app_all:haulcast_app"]
    assert by_table["django_migrations"][1] == []


# --------------------------------------------------------------------------- runtime role powers


def _row_for(table: str, key: str) -> tuple[sql.SQL, list[object]]:
    """An INSERT statement (and parameters) that satisfies ``table``'s NOT NULL columns."""
    expires = FAR_FUTURE
    now = datetime.now(UTC)
    rows: dict[str, tuple[sql.SQL, list[object]]] = {
        "geocode_cache": (
            sql.SQL(
                "INSERT INTO app.geocode_cache (key, payload, provider, expires_at) "
                "VALUES (%s, '[]', 'p', %s)"
            ),
            [key, expires],
        ),
        "route_cache": (
            sql.SQL(
                "INSERT INTO app.route_cache (key, payload, provider, expires_at) "
                "VALUES (%s, '[]', 'p', %s)"
            ),
            [key, expires],
        ),
        "weather_cache": (
            sql.SQL(
                "INSERT INTO app.weather_cache (location_key, model, variables_hash, "
                "window_start, hours, payload, expires_at) "
                "VALUES (%s, 'm', 'h', %s, 1, '{}', %s)"
            ),
            [key, now, expires],
        ),
        "plan": (
            sql.SQL(
                "INSERT INTO app.plan (id, request_hash, request, result, expires_at) "
                "VALUES (%s, 'h', '{}', '{}', %s)"
            ),
            [key, expires],
        ),
        "rate_limit_bucket": (
            sql.SQL(
                "INSERT INTO app.rate_limit_bucket (key, tat, last_allowed, updated_at, "
                "expires_at) VALUES (%s, %s, true, %s, %s)"
            ),
            [key, now, now, expires],
        ),
        "upstream_budget": (
            sql.SQL(
                "INSERT INTO app.upstream_budget (key, tat, last_allowed, updated_at, "
                "expires_at) VALUES (%s, %s, true, %s, %s)"
            ),
            [key, now, now, expires],
        ),
    }
    return rows[table]


@pytest.mark.usefixtures("clean_tables")
@pytest.mark.parametrize("table", TTL_TABLES)
def test_runtime_role_can_insert_read_update_and_delete(
    app_connection: Connection, table: str
) -> None:
    statement, params = _row_for(table, "row-1")
    relation = sql.Identifier("app", table)

    app_connection.execute(statement, params)
    count = app_connection.execute(sql.SQL("SELECT count(*) FROM {}").format(relation)).fetchone()
    app_connection.execute(sql.SQL("UPDATE {} SET expires_at = expires_at").format(relation))
    app_connection.execute(sql.SQL("DELETE FROM {}").format(relation))

    assert count == (1,)


@pytest.mark.parametrize(
    "statement",
    [
        pytest.param(sql.SQL("CREATE TABLE app.sneaky (id int)"), id="create-table"),
        pytest.param(sql.SQL("ALTER TABLE app.plan ADD COLUMN sneaky int"), id="alter-table"),
        pytest.param(sql.SQL("DROP TABLE app.plan"), id="drop-table"),
        pytest.param(sql.SQL("TRUNCATE app.plan"), id="truncate"),
        pytest.param(sql.SQL("CREATE INDEX sneaky_idx ON app.plan (created_at)"), id="index"),
        pytest.param(
            sql.SQL("CREATE FUNCTION app.sneaky() RETURNS int LANGUAGE sql AS 'SELECT 1'"),
            id="function",
        ),
        pytest.param(sql.SQL("ALTER TABLE app.plan DISABLE ROW LEVEL SECURITY"), id="disable-rls"),
        pytest.param(sql.SQL("CREATE POLICY sneaky ON app.plan USING (true)"), id="policy"),
        pytest.param(sql.SQL("DROP POLICY haulcast_app_all ON app.plan"), id="drop-policy"),
        pytest.param(sql.SQL("CREATE SCHEMA sneaky"), id="schema"),
        pytest.param(sql.SQL("CREATE TABLE public.sneaky (id int)"), id="public-table"),
    ],
)
def test_runtime_role_cannot_change_the_schema(
    app_connection: Connection, statement: sql.SQL
) -> None:
    with pytest.raises((errors.InsufficientPrivilege, errors.InvalidSchemaName)):
        app_connection.execute(statement)


def test_runtime_role_cannot_touch_the_migration_history(app_connection: Connection) -> None:
    with pytest.raises(errors.InsufficientPrivilege):
        app_connection.execute("SELECT * FROM app.django_migrations")
    with pytest.raises(errors.InsufficientPrivilege):
        app_connection.execute("DELETE FROM app.django_migrations")


def test_runtime_role_searches_schema_app_by_default(app_connection: Connection) -> None:
    row = app_connection.execute("SHOW search_path").fetchone()

    assert row == ("app",)


@pytest.mark.usefixtures("clean_tables")
def test_runtime_role_can_execute_the_sql_functions(app_connection: Connection) -> None:
    limited = app_connection.execute(
        "SELECT allowed FROM app.rate_limit_take('k', 1, interval '1 minute', 1)"
    ).fetchone()
    cleaned = app_connection.execute("SELECT count(*) FROM app.cleanup_expired()").fetchone()

    assert limited == (True,)
    assert cleaned == (6,)


@pytest.mark.usefixtures("clean_tables")
def test_rls_hides_rows_from_a_role_that_was_granted_access_by_mistake(
    admin_connection: Connection, app_connection: Connection
) -> None:
    peeker = f"t5a_peeker_{secrets.token_hex(4)}"
    admin_connection.execute(sql.SQL("CREATE ROLE {} LOGIN").format(sql.Identifier(peeker)))
    admin_connection.execute(
        sql.SQL("GRANT USAGE ON SCHEMA app TO {}").format(sql.Identifier(peeker))
    )
    admin_connection.execute(
        sql.SQL("GRANT SELECT, INSERT ON app.plan TO {}").format(sql.Identifier(peeker))
    )
    statement, params = _row_for("plan", "pln_visible_to_runtime_only")
    app_connection.execute(statement, params)
    try:
        with connect("default", user=peeker) as stranger:
            assert stranger.execute("SELECT count(*) FROM app.plan").fetchone() == (0,)
            with pytest.raises(errors.InsufficientPrivilege):
                stranger.execute(statement, params)
        assert app_connection.execute("SELECT count(*) FROM app.plan").fetchone() == (1,)
        assert admin_connection.execute(
            "SELECT has_function_privilege(%s, 'app.cleanup_expired()', 'EXECUTE')", [peeker]
        ).fetchone() == (False,)
    finally:
        admin_connection.execute(
            sql.SQL("REVOKE ALL ON app.plan FROM {}").format(sql.Identifier(peeker))
        )
        admin_connection.execute(
            sql.SQL("REVOKE USAGE ON SCHEMA app FROM {}").format(sql.Identifier(peeker))
        )
        drop_roles(peeker)


# --------------------------------------------------------------------------- models


@pytest.mark.parametrize(
    ("instance", "expected"),
    [
        (GeocodeCache(key="geocode:denver"), "geocode:denver"),
        (RouteCache(key="route:a>b"), "route:a>b"),
        (Plan(id="pln_01"), "pln_01"),
        (RateLimitBucket(key="plans:minute:abc"), "plans:minute:abc"),
        (UpstreamBudget(key="openmeteo:minute"), "openmeteo:minute"),
        (
            WeatherCache(
                location_key="+397,-1050",
                model="best_match",
                window_start=datetime(2026, 10, 20, 14, tzinfo=UTC),
            ),
            "best_match +397,-1050 @ 2026-10-20T14",
        ),
    ],
)
def test_models_are_readable_in_logs_and_shells(instance: object, expected: str) -> None:
    assert str(instance) == expected


@pytest.mark.django_db
def test_database_defaults_stamp_creation_times_and_weather_keys_are_unique() -> None:
    row = GeocodeCache.objects.create(
        key="k", payload=[], provider="p", expires_at=datetime.now(UTC) + timedelta(days=1)
    )
    row.refresh_from_db()

    assert abs(row.created_at - datetime.now(UTC)) < timedelta(minutes=5)
    window = datetime(2026, 10, 20, 14, tzinfo=UTC)
    fields = {
        "location_key": "+397,-1050",
        "model": "m",
        "variables_hash": "h",
        "window_start": window,
        "hours": 49,
        "payload": {},
        "expires_at": window,
    }
    WeatherCache.objects.create(**fields)
    with pytest.raises(Exception, match="weather_cache_lookup_uniq"):
        WeatherCache.objects.create(**fields)


# --------------------------------------------------------------------------- migrations


@pytest.mark.django_db
def test_models_and_migrations_agree() -> None:
    call_command("makemigrations", "--check", "--dry-run", verbosity=0)


@pytest.mark.django_db(transaction=True, databases=["default", "owner"])
def test_migrations_roll_back_to_nothing_and_forward_again(admin_connection: Connection) -> None:
    def objects() -> tuple[list[object], list[object]]:
        tables = admin_connection.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'app' "
            "AND tablename <> 'django_migrations' ORDER BY 1"
        ).fetchall()
        functions = admin_connection.execute(
            "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
            "WHERE n.nspname = 'app' ORDER BY 1"
        ).fetchall()
        return [row[0] for row in tables], [row[0] for row in functions]

    try:
        call_command("migrate", "store", "zero", database="owner", verbosity=0)
        assert objects() == ([], [])
    finally:
        call_command("migrate", "store", database="owner", verbosity=0)

    tables, functions = objects()
    assert tables == sorted(TTL_TABLES)
    assert functions == ["cleanup_expired", "rate_limit_take", "upstream_budget_take"]


@pytest.mark.django_db(transaction=True, databases=["default", "owner"])
def test_cleanup_job_is_scheduled_through_pg_cron_when_it_exists(
    admin_connection: Connection,
) -> None:
    stub = (
        sql.SQL("CREATE SCHEMA cron"),
        sql.SQL("CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text)"),
        sql.SQL("CREATE TABLE cron.calls (kind text, job text, schedule text, command text)"),
        sql.SQL(
            "CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) "
            "RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$ "
            "INSERT INTO cron.calls VALUES ('schedule', job_name, schedule, command); "
            "INSERT INTO cron.job (jobname) VALUES (job_name); SELECT 1::bigint $$"
        ),
        sql.SQL(
            "CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean "
            "LANGUAGE sql SECURITY DEFINER AS $$ "
            "INSERT INTO cron.calls VALUES ('unschedule', job_name, NULL, NULL); "
            "DELETE FROM cron.job WHERE jobname = job_name; SELECT true $$"
        ),
        sql.SQL("GRANT USAGE ON SCHEMA cron TO haulcast_owner"),
        sql.SQL("GRANT SELECT ON cron.job TO haulcast_owner"),
    )
    try:
        call_command("migrate", "store", "0003", database="owner", verbosity=0)
        for statement in stub:
            admin_connection.execute(statement)

        call_command("migrate", "store", "0004", database="owner", verbosity=0)
        scheduled = admin_connection.execute("SELECT * FROM cron.calls").fetchall()
        call_command("migrate", "store", "0003", database="owner", verbosity=0)
        calls = admin_connection.execute(
            "SELECT kind, job FROM cron.calls ORDER BY 1 DESC"
        ).fetchall()
    finally:
        admin_connection.execute("DROP SCHEMA IF EXISTS cron CASCADE")
        call_command("migrate", "store", database="owner", verbosity=0)

    assert scheduled == [
        ("schedule", "haulcast-cleanup", "7 * * * *", "SELECT * FROM app.cleanup_expired()")
    ]
    assert calls == [("unschedule", "haulcast-cleanup"), ("schedule", "haulcast-cleanup")]


# --------------------------------------------------------------------------- retiring pg_cron


def _install_cron_stub(admin_connection: Connection, *, usage: bool, with_job: bool) -> None:
    """A stand-in for the pg_cron extension: its objects plus a log of calls made to it."""
    statements = [
        sql.SQL("CREATE SCHEMA cron"),
        sql.SQL("CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text)"),
        sql.SQL("CREATE TABLE cron.calls (kind text, job text)"),
        sql.SQL(
            "CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) "
            "RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$ "
            "INSERT INTO cron.calls VALUES ('schedule', job_name); "
            "INSERT INTO cron.job (jobname) VALUES (job_name); SELECT 1::bigint $$"
        ),
        sql.SQL(
            "CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean "
            "LANGUAGE sql SECURITY DEFINER AS $$ "
            "INSERT INTO cron.calls VALUES ('unschedule', job_name); "
            "DELETE FROM cron.job WHERE jobname = job_name; SELECT true $$"
        ),
    ]
    if with_job:
        statements.append(sql.SQL("INSERT INTO cron.job (jobname) VALUES ('haulcast-cleanup')"))
    if usage:
        statements += [
            sql.SQL("GRANT USAGE ON SCHEMA cron TO haulcast_owner"),
            sql.SQL("GRANT SELECT ON cron.job TO haulcast_owner"),
        ]
    for statement in statements:
        admin_connection.execute(statement)


@pytest.mark.django_db(transaction=True, databases=["default", "owner"])
def test_retiring_the_hourly_job_unschedules_what_migration_0004_scheduled(
    admin_connection: Connection,
) -> None:
    try:
        call_command("migrate", "store", "0003", database="owner", verbosity=0)
        _install_cron_stub(admin_connection, usage=True, with_job=False)
        call_command("migrate", "store", "0004", database="owner", verbosity=0)
        jobs_after_0004 = admin_connection.execute("SELECT jobname FROM cron.job").fetchall()

        call_command("migrate", "store", "0005", database="owner", verbosity=0)
        jobs_after_0005 = admin_connection.execute("SELECT jobname FROM cron.job").fetchall()
        call_command("migrate", "store", "0004", database="owner", verbosity=0)
        jobs_after_reverse = admin_connection.execute("SELECT jobname FROM cron.job").fetchall()
        calls = admin_connection.execute("SELECT kind, job FROM cron.calls ORDER BY 1").fetchall()
    finally:
        admin_connection.execute("DROP SCHEMA IF EXISTS cron CASCADE")
        call_command("migrate", "store", database="owner", verbosity=0)

    assert jobs_after_0004 == [("haulcast-cleanup",)]
    assert jobs_after_0005 == []
    # Reversing a retirement must not bring the hourly job back: daily Vercel Cron is the only
    # cleanup (decision D-32).
    assert jobs_after_reverse == []
    assert calls == [("schedule", "haulcast-cleanup"), ("unschedule", "haulcast-cleanup")]


@pytest.mark.django_db(transaction=True, databases=["default", "owner"])
def test_retiring_the_hourly_job_leaves_a_server_without_a_job_alone(
    admin_connection: Connection,
) -> None:
    try:
        call_command("migrate", "store", "0004", database="owner", verbosity=0)
        _install_cron_stub(admin_connection, usage=True, with_job=False)

        call_command("migrate", "store", "0005", database="owner", verbosity=0)
        calls = admin_connection.execute("SELECT kind, job FROM cron.calls").fetchall()
    finally:
        admin_connection.execute("DROP SCHEMA IF EXISTS cron CASCADE")
        call_command("migrate", "store", database="owner", verbosity=0)

    assert calls == []


@pytest.mark.django_db(transaction=True, databases=["default", "owner"])
def test_retiring_the_hourly_job_survives_a_cron_schema_the_owner_cannot_use(
    admin_connection: Connection,
) -> None:
    # The third state of decision D-10: the schema exists, EXECUTE reaches the owner through PUBLIC,
    # but without USAGE on the schema even looking a function up raises "permission denied".
    try:
        call_command("migrate", "store", "0004", database="owner", verbosity=0)
        _install_cron_stub(admin_connection, usage=False, with_job=True)

        call_command("migrate", "store", "0005", database="owner", verbosity=0)
        calls = admin_connection.execute("SELECT kind, job FROM cron.calls").fetchall()
        jobs = admin_connection.execute("SELECT jobname FROM cron.job").fetchall()
    finally:
        admin_connection.execute("DROP SCHEMA IF EXISTS cron CASCADE")
        call_command("migrate", "store", database="owner", verbosity=0)

    assert calls == []
    assert jobs == [("haulcast-cleanup",)]
