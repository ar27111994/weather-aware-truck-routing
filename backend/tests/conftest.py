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
#
# Every profile names its parent and whether it is derandomised. A profile registered without a
# parent inherits whichever profile is loaded at that moment, and on GitHub Actions (CI=true) that
# is Hypothesis' own derandomised "ci" profile: this project's "ci" used to inherit it without
# anybody saying so, so CI replayed the same 500 examples on every run while a developer's machine
# found a flaky property that CI never could (R2-25). tests/test_hypothesis_profiles.py pins this.
_DEFAULT = hypothesis_settings.get_profile("default")
# On a developer's machine: fresh examples every run, so a flaky property shows up early.
hypothesis_settings.register_profile(
    "dev", parent=_DEFAULT, max_examples=50, deadline=None, derandomize=False
)
# Pull requests: the same 500 examples on every run, on purpose. A red check is the change's own and
# can be replayed; it is never luck. Exploring new examples is the job of "explore".
hypothesis_settings.register_profile(
    "ci", parent=_DEFAULT, max_examples=500, deadline=None, derandomize=True, print_blob=True
)
# Weekly (.github/workflows/property-tests.yml): fresh examples every run under a printed seed.
hypothesis_settings.register_profile(
    "explore",
    parent=_DEFAULT,
    max_examples=2_000,
    deadline=None,
    derandomize=False,
    database=None,
    print_blob=True,
)
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
