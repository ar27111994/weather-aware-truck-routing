"""Idempotent database bootstrap: roles, schema ownership and the least-privilege grant model.

Run once per database (and again whenever a password rotates) with an *admin* connection: on
Supabase the ``postgres`` owner through the session pooler (``DATABASE_URL``), in CI/local the
cluster superuser. It creates:

* ``haulcast_owner``: owns schema ``app``, runs the Django migrations (DDL);
* ``haulcast_app``: the runtime role, plain DML on the tables (granted by *default privileges*, so
  every table a migration adds is usable without further grants) and EXECUTE on the functions.

Both roles are plain logins (no superuser, no create-db/role, no replication, no BYPASSRLS) whose
``search_path`` is ``app``; that is how Django's unqualified table names land in the schema without
quoted ``db_table`` tricks. Nothing in schema ``app`` is reachable by ``PUBLIC`` or by Supabase's
``anon`` / ``authenticated`` / ``service_role``. Passwords are sent as SCRAM-SHA-256 verifiers
computed client-side, so a plaintext password never reaches a server log. The run ends by
*verifying* the resulting privilege matrix and fails loudly (rolling everything back) if anything
is off. It never prints a secret.
"""

import argparse
import os
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final

import psycopg
from psycopg import sql
from psycopg.rows import TupleRow

from haulcast.config.env import (
    APP_ROLE,
    OWNER_ROLE,
    ConfigError,
    database_from_url,
    default_sslmode,
)

SUPABASE_ROLES: Final = ("anon", "authenticated", "service_role")
MIN_PASSWORD_LENGTH: Final = 16
_ADVISORY_LOCK_KEY: Final = "haulcast-bootstrap"
_ROLE_ATTRIBUTES: Final = (
    # (pg_roles column, wanted value, the clause that sets it): the one definition of "plain login".
    ("rolcanlogin", True, "LOGIN"),
    ("rolsuper", False, "NOSUPERUSER"),
    ("rolcreatedb", False, "NOCREATEDB"),
    ("rolcreaterole", False, "NOCREATEROLE"),
    ("rolreplication", False, "NOREPLICATION"),
    ("rolbypassrls", False, "NOBYPASSRLS"),
)
_CONNECT_TIMEOUT_S: Final = 15

Query = sql.SQL | sql.Composed


class BootstrapError(RuntimeError):
    """The database does not end up in the expected state (or the inputs are unusable)."""


@dataclass(frozen=True, slots=True)
class BootstrapNames:
    """Names of the two roles and the schema (tests use throw-away ones)."""

    owner: str = OWNER_ROLE
    app: str = APP_ROLE
    schema: str = "app"
    api_roles: tuple[str, ...] = SUPABASE_ROLES
    """Roles that must never reach the schema (Supabase's Data API roles)."""


DEFAULT_NAMES: Final = BootstrapNames()


@dataclass(frozen=True, slots=True)
class BootstrapPasswords:
    """Passwords for the two roles (never logged, never echoed)."""

    owner: str
    app: str

    def __post_init__(self) -> None:
        """Refuse weak passwords: generated ones are 40+ characters."""
        for label, password in (("owner", self.owner), ("app", self.app)):
            if len(password) < MIN_PASSWORD_LENGTH:
                raise BootstrapError(
                    f"the {label} role password must be at least {MIN_PASSWORD_LENGTH} characters"
                )


@dataclass(frozen=True, slots=True)
class BootstrapReport:
    """What the run changed or found (safe to print)."""

    created_roles: tuple[str, ...]
    existing_roles: tuple[str, ...]
    pg_cron_ready: bool


def _scalar(
    cursor: psycopg.Cursor[TupleRow], query: Query, params: Sequence[object] = ()
) -> object:
    cursor.execute(query, params)
    row = cursor.fetchone()
    return None if row is None else row[0]


def _ensure_role(
    conn: psycopg.Connection[TupleRow],
    cursor: psycopg.Cursor[TupleRow],
    role: str,
    password: str,
) -> bool:
    """Create ``role``, or converge an existing one; return whether it was created.

    A new role gets every wanted attribute. An existing role is altered only where it deviates,
    plus its credential. PostgreSQL 16+ denies non-superusers (Supabase's ``postgres``) clauses such
    as ``NOSUPERUSER`` outright, even when the role already complies, and a deploy re-runs this
    bootstrap every time. A deviation the admin may not repair therefore fails the run loudly, and
    :func:`_verify` proves the attributes of every role that was left alone.
    """
    verifier = conn.pgconn.encrypt_password(
        password.encode(), role.encode(), b"scram-sha-256"
    ).decode()
    cursor.execute(
        sql.SQL("SELECT {columns} FROM pg_roles WHERE rolname = %s").format(
            columns=sql.SQL(", ").join(sql.Identifier(column) for column, _, _ in _ROLE_ATTRIBUTES)
        ),
        (role,),
    )
    current = cursor.fetchone()
    if current is None:
        clauses = [clause for _, _, clause in _ROLE_ATTRIBUTES]
    else:
        clauses = [
            clause
            for (_, wanted, clause), actual in zip(_ROLE_ATTRIBUTES, current, strict=True)
            if bool(actual) != wanted
        ]
    options = sql.SQL(" ").join(
        [
            *(sql.SQL(clause) for clause in clauses),
            sql.SQL("PASSWORD {}").format(sql.Literal(verifier)),
        ]
    )
    cursor.execute(
        sql.SQL("{verb} ROLE {role} WITH {options}").format(
            verb=sql.SQL("CREATE" if current is None else "ALTER"),
            role=sql.Identifier(role),
            options=options,
        )
    )
    return current is None


_REVOKE_FROM_SUPABASE_ROLES = sql.SQL(
    """
DO $do$
DECLARE
    r text;
BEGIN
    FOREACH r IN ARRAY ARRAY[{roles}] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', {schema}, r);
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', {schema}, r);
            EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', {schema}, r);
            EXECUTE format('REVOKE ALL ON ALL ROUTINES IN SCHEMA %I FROM %I', {schema}, r);
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON TABLES FROM %I',
                {owner}, {schema}, r);
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM %I',
                {owner}, {schema}, r);
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON ROUTINES FROM %I',
                {owner}, {schema}, r);
        END IF;
    END LOOP;
END
$do$
"""
)

_GRANT_PG_CRON = sql.SQL(
    """
DO $do$
BEGIN
    IF to_regnamespace('cron') IS NOT NULL THEN
        BEGIN
            EXECUTE format('GRANT USAGE ON SCHEMA cron TO %I', {owner});
            EXECUTE format(
                'GRANT EXECUTE ON FUNCTION cron.schedule(text,text,text), '
                    || 'cron.unschedule(text) TO %I',
                {owner});
            EXECUTE format('GRANT SELECT ON cron.job TO %I', {owner});
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE 'could not grant pg_cron access: the cleanup job will not be scheduled';
        END;
    END IF;
END
$do$
"""
)


def _configure_schema(cursor: psycopg.Cursor[TupleRow], names: BootstrapNames) -> None:
    """Create the schema and wire ownership, search paths and the privilege model."""
    identifiers = {
        "owner": sql.Identifier(names.owner),
        "app": sql.Identifier(names.app),
        "schema": sql.Identifier(names.schema),
    }
    statements = (
        # The admin must be able to hand the schema to the owner role and to configure its default
        # privileges; on Supabase `postgres` is no superuser, so SET on the role is granted here.
        "GRANT {owner} TO CURRENT_USER WITH SET TRUE",
        "CREATE SCHEMA IF NOT EXISTS {schema}",
        "ALTER SCHEMA {schema} OWNER TO {owner}",
        "ALTER ROLE {owner} SET search_path = {schema}",
        "ALTER ROLE {app} SET search_path = {schema}",
        "REVOKE ALL ON SCHEMA {schema} FROM PUBLIC",
        "GRANT USAGE ON SCHEMA {schema} TO {app}",
        # Every table the owner creates is usable by the runtime role, nothing else is.
        (
            "ALTER DEFAULT PRIVILEGES FOR ROLE {owner} IN SCHEMA {schema} "
            "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {app}"
        ),
        (
            "ALTER DEFAULT PRIVILEGES FOR ROLE {owner} IN SCHEMA {schema} "
            "GRANT USAGE, SELECT ON SEQUENCES TO {app}"
        ),
        # Functions are executable by PUBLIC unless revoked: the global form removes that default.
        "ALTER DEFAULT PRIVILEGES FOR ROLE {owner} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC",
        (
            "ALTER DEFAULT PRIVILEGES FOR ROLE {owner} IN SCHEMA {schema} "
            "GRANT EXECUTE ON FUNCTIONS TO {app}"
        ),
    )
    for statement in statements:
        cursor.execute(sql.SQL(statement).format(**identifiers))
    cursor.execute(
        _REVOKE_FROM_SUPABASE_ROLES.format(
            roles=sql.SQL(", ").join(sql.Literal(role) for role in names.api_roles),
            schema=sql.Literal(names.schema),
            owner=sql.Literal(names.owner),
        )
    )


def _grant_pg_cron(cursor: psycopg.Cursor[TupleRow], names: BootstrapNames) -> bool:
    """Let the owner schedule the cleanup job when pg_cron exists; report whether it can."""
    cursor.execute(_GRANT_PG_CRON.format(owner=sql.Literal(names.owner)))
    return bool(
        _scalar(
            cursor,
            sql.SQL(
                "SELECT to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL "
                "AND has_function_privilege(%s, 'cron.schedule(text,text,text)', 'EXECUTE')"
            ),
            (names.owner,),
        )
    )


def _checks(names: BootstrapNames) -> tuple[tuple[str, Query, tuple[object, ...]], ...]:
    """The privilege matrix the bootstrap must have produced: ``(description, query, params)``."""
    roles = [names.owner, names.app]
    return (
        (
            "the runtime role can use the schema",
            sql.SQL("SELECT has_schema_privilege(%s, %s, 'USAGE')"),
            (names.app, names.schema),
        ),
        (
            "the runtime role cannot create objects in the schema",
            sql.SQL("SELECT NOT has_schema_privilege(%s, %s, 'CREATE')"),
            (names.app, names.schema),
        ),
        (
            "the owner role can create objects in the schema",
            sql.SQL("SELECT has_schema_privilege(%s, %s, 'CREATE')"),
            (names.owner, names.schema),
        ),
        (
            "the owner role owns the schema",
            sql.SQL("SELECT pg_get_userbyid(nspowner) = %s FROM pg_namespace WHERE nspname = %s"),
            (names.owner, names.schema),
        ),
        (
            "PUBLIC holds no privilege on the schema",
            sql.SQL(
                "SELECT NOT EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL "
                "aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a "
                "WHERE n.nspname = %s AND a.grantee = 0)"
            ),
            (names.schema,),
        ),
        (
            "no Supabase API role can use the schema",
            sql.SQL(
                "SELECT NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = ANY(%s) "
                "AND has_schema_privilege(r.rolname, %s, 'USAGE'))"
            ),
            (list(names.api_roles), names.schema),
        ),
        (
            "both roles are plain logins without elevated attributes",
            sql.SQL(
                "SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ANY(%s) AND "
                "(NOT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication "
                "OR rolbypassrls))"
            ),
            (roles,),
        ),
        (
            "both roles default to the schema as search_path",
            sql.SQL(
                "SELECT count(*) = 2 FROM pg_roles WHERE rolname = ANY(%s) "
                "AND coalesce(rolconfig, '{}') @> ARRAY['search_path=' || %s]"
            ),
            (roles, names.schema),
        ),
    )


def _verify(cursor: psycopg.Cursor[TupleRow], names: BootstrapNames) -> None:
    """Check the resulting privilege matrix; raise :class:`BootstrapError` listing every miss."""
    failures = [
        description
        for description, query, params in _checks(names)
        if _scalar(cursor, query, params) is not True
    ]
    if failures:
        raise BootstrapError("verification failed: " + "; ".join(failures))


def bootstrap(
    conn: psycopg.Connection[TupleRow],
    passwords: BootstrapPasswords,
    names: BootstrapNames = DEFAULT_NAMES,
) -> BootstrapReport:
    """Create or update the roles and schema on ``conn`` (an admin connection); all-or-nothing.

    Safe to re-run: it converges on the same state and re-applies the passwords.

    Raises:
        BootstrapError: the resulting privilege matrix does not match the model (nothing is kept).
    """
    created: list[str] = []
    existing: list[str] = []
    with conn.transaction(), conn.cursor() as cursor:
        cursor.execute(sql.SQL("SELECT pg_advisory_xact_lock(hashtext(%s))"), (_ADVISORY_LOCK_KEY,))
        for role, password in ((names.owner, passwords.owner), (names.app, passwords.app)):
            was_created = _ensure_role(conn, cursor, role, password)
            (created if was_created else existing).append(role)
        _configure_schema(cursor, names)
        pg_cron_ready = _grant_pg_cron(cursor, names)
        _verify(cursor, names)
    return BootstrapReport(tuple(created), tuple(existing), pg_cron_ready)


def _required(environ: Mapping[str, str], name: str) -> str:
    value = environ.get(name, "").strip()
    if not value:
        raise BootstrapError(f"{name} is required")
    return value


def main(argv: Sequence[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    """Command-line entry point: read the admin DSN and the role passwords from the environment."""
    parser = argparse.ArgumentParser(
        prog="bootstrap_db", description=(__doc__ or "").split("\n\n", maxsplit=1)[0]
    )
    parser.parse_args(argv)
    env = os.environ if environ is None else environ
    try:
        entry = database_from_url(_required(env, "DATABASE_URL"))
        passwords = BootstrapPasswords(
            owner=_required(env, "HAULCAST_OWNER_DB_PASSWORD"),
            app=_required(env, "HAULCAST_APP_DB_PASSWORD"),
        )
        with psycopg.connect(
            host=entry["HOST"],
            port=entry["PORT"],
            dbname=entry["NAME"],
            user=entry["USER"],
            password=entry["PASSWORD"],
            sslmode=entry["OPTIONS"].get("sslmode", default_sslmode(entry["HOST"])),
            connect_timeout=_CONNECT_TIMEOUT_S,
            autocommit=True,
        ) as conn:
            report = bootstrap(conn, passwords)
    except (BootstrapError, ConfigError, psycopg.Error) as exc:
        message = str(exc).splitlines()[0] if str(exc) else ""
        sys.stderr.write(f"bootstrap_db failed: {type(exc).__name__}: {message}\n")
        return 1
    sys.stdout.write(
        f"created roles: {', '.join(report.created_roles) or '-'}\n"
        f"updated roles: {', '.join(report.existing_roles) or '-'}\n"
        f"pg_cron cleanup scheduling available: {'yes' if report.pg_cron_ready else 'no'}\n"
    )
    return 0
