"""Shared pytest configuration: Hypothesis profiles and the least-privilege test database.

pytest-django's default database creation is replaced by the same sequence a real deployment runs:

1. create an empty throw-away database (``HAULCAST_TEST_DB_NAME``; dropped again afterwards),
2. run ``bootstrap`` (roles, schema ``app``, privilege model) as the admin,
3. run the Django migrations as ``haulcast_owner``.

So every test sees tables owned by the owner role, granted to the runtime role by default
privileges, protected by row level security: the production layout, not an approximation of it.
"""

import os
from collections.abc import Iterator

import pytest
from django.conf import settings
from django.core.management import call_command
from django.db import connections
from hypothesis import settings as hypothesis_settings
from psycopg import sql
from pytest_django.plugin import DjangoDbBlocker

from haulcast.store.bootstrap import BootstrapPasswords, bootstrap
from tests.dbtools import Connection, connect

# Property tests assert correctness, not speed: wall-clock deadlines only add flakiness on busy
# machines. Performance budgets are asserted by dedicated benchmarks instead.
hypothesis_settings.register_profile("dev", max_examples=50, deadline=None)
hypothesis_settings.register_profile("ci", max_examples=500, deadline=None)
hypothesis_settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "dev"))


@pytest.fixture(scope="session")
def test_database_name() -> str:
    """Name of the throw-away database every test of this session runs against."""
    return str(settings.DATABASES["default"]["TEST"]["NAME"])


@pytest.fixture(scope="session")
def django_db_setup(django_db_blocker: DjangoDbBlocker, test_database_name: str) -> Iterator[None]:
    """Create, bootstrap and migrate the test database; drop it when the session ends."""
    passwords = BootstrapPasswords(
        owner=settings.DATABASES["owner"]["PASSWORD"], app=settings.DATABASES["app"]["PASSWORD"]
    )
    name = sql.Identifier(test_database_name)
    with django_db_blocker.unblock():
        with connect("default", "postgres") as admin:
            admin.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(name))
            admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(name))
        with connect("default", test_database_name) as database:
            bootstrap(database, passwords)
        for alias in connections:
            connections[alias].close()
            connections[alias].settings_dict["NAME"] = test_database_name
        call_command("migrate", database="owner", verbosity=0, interactive=False)
        yield
        for alias in connections:
            connections[alias].close()
        with connect("default", "postgres") as admin:
            admin.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(name))


@pytest.fixture
def app_connection(
    django_db_setup: None, django_db_blocker: DjangoDbBlocker
) -> Iterator[Connection]:
    """A fresh autocommit connection to the test database as the runtime role ``haulcast_app``."""
    with django_db_blocker.unblock(), connect("app") as connection:
        yield connection


@pytest.fixture
def admin_connection(
    django_db_setup: None, django_db_blocker: DjangoDbBlocker
) -> Iterator[Connection]:
    """A fresh autocommit connection to the test database as the cluster superuser."""
    with django_db_blocker.unblock(), connect("default") as connection:
        yield connection
