"""Django settings for the test-suite.

Identical to production except for the databases. The suite must never reach a real deployment, so
``DATABASE_URL`` is ignored here and ``TEST_DATABASE_URL`` (printed by ``scripts/dev-db.sh url``;
a cluster superuser) is required. Three aliases point at the same throw-away test database:

* ``default``: the superuser, with ``search_path = app``; it creates and migrates the database and
  serves most tests (the ORM has to see the ``app`` tables);
* ``owner``: ``haulcast_owner``, the role the migrations run as, exactly like in production;
* ``app``: ``haulcast_app``, the runtime role: tests that prove least privilege connect as it.

The role passwords are random per run (never literals), the database name comes from
``HAULCAST_TEST_DB_NAME`` so concurrent workers on one machine never collide.
"""

import os
import secrets

from haulcast.config.env import APP_ROLE, OWNER_ROLE, ConfigError, database_from_url, role_database
from haulcast.config.settings import *

_test_database_url = os.environ.get("TEST_DATABASE_URL", "").strip()
if not _test_database_url:
    raise ConfigError(
        "TEST_DATABASE_URL is required: run `bash scripts/dev-db.sh start`, "
        'then `export "$(bash scripts/dev-db.sh url)"`.',
    )

_admin = database_from_url(_test_database_url)
_test_database_name = (
    os.environ.get("HAULCAST_TEST_DB_NAME", "").strip() or f"test_{_admin['NAME']}"
)
_owner_password = os.environ.setdefault("HAULCAST_OWNER_DB_PASSWORD", secrets.token_urlsafe(32))
_app_password = os.environ.setdefault("HAULCAST_APP_DB_PASSWORD", secrets.token_urlsafe(32))

_admin["OPTIONS"]["options"] = "-c search_path=app"
_admin["TEST"] = {"NAME": _test_database_name}
DATABASES = {
    "default": _admin,
    "owner": role_database(
        _test_database_url, role=OWNER_ROLE, password=_owner_password, runtime=False
    ),
    "app": role_database(_test_database_url, role=APP_ROLE, password=_app_password, runtime=True),
}

SECRET_KEY = "test-only-secret-key-never-used-outside-the-test-suite-0123456789"
DEBUG = False
HAULCAST_COMMIT = "0000000"
HAULCAST_RATE_LIMIT_SALT = secrets.token_urlsafe(24)
HAULCAST_CRON_SECRET = None
HAULCAST_CLIENT_IP_HEADER = None
HAULCAST_ALLOWED_ORIGINS = ()
