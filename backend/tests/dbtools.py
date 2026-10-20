"""Helpers for tests that talk to PostgreSQL directly (outside the ORM).

Every connection is autocommit and uses the credentials of a settings alias (``default`` =
cluster superuser, ``owner`` = ``haulcast_owner``, ``app`` = ``haulcast_app``), optionally against a
different database. Scratch databases and roles carry random suffixes: the local server is shared
with other workers and role names are cluster-wide, so tests never touch a name they did not create.
"""

import secrets
from collections.abc import Iterator
from contextlib import contextmanager, suppress

import psycopg
from django.conf import settings
from psycopg import sql

from haulcast.config.env import default_sslmode
from haulcast.store.bootstrap import BootstrapNames

Connection = psycopg.Connection[tuple[object, ...]]


def connect(alias: str, dbname: str | None = None, *, user: str | None = None) -> Connection:
    """Open an autocommit connection using settings alias ``alias`` (or ``user`` on that server)."""
    entry = settings.DATABASES[alias]
    return psycopg.connect(
        host=entry["HOST"],
        port=entry["PORT"],
        user=user or entry["USER"],
        password=entry["PASSWORD"],
        dbname=dbname or entry["NAME"],
        sslmode=entry["OPTIONS"].get("sslmode", default_sslmode(entry["HOST"])),
        autocommit=True,
    )


def throwaway_names() -> BootstrapNames:
    """Role and schema names that cannot collide with anything real or with another test."""
    suffix = secrets.token_hex(4)
    return BootstrapNames(
        owner=f"t5a_owner_{suffix}",
        app=f"t5a_app_{suffix}",
        schema=f"t5a_schema_{suffix}",
        api_roles=(f"t5a_anon_{suffix}", f"t5a_authenticated_{suffix}"),
    )


@contextmanager
def scratch_database(prefix: str) -> Iterator[str]:
    """Create an empty database with a random name; drop it (and connections to it) afterwards."""
    name = f"{prefix}_{secrets.token_hex(4)}"
    identifier = sql.Identifier(name)
    with connect("default", "postgres") as admin:
        admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(identifier))
    try:
        yield name
    finally:
        with connect("default", "postgres") as admin:
            admin.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(identifier))


def drop_roles(*roles: str) -> None:
    """Drop throw-away roles (their owning database must already be gone)."""
    with connect("default", "postgres") as admin:
        for role in roles:
            with suppress(psycopg.Error):
                admin.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(role)))
