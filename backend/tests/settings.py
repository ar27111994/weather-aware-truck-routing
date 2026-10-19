"""Django settings for the test-suite.

Identical to production except that the database is the local test Postgres. The suite must never
reach a real deployment, so ``DATABASE_URL`` is ignored here and ``TEST_DATABASE_URL`` (printed by
``scripts/dev-db.sh url``) is required.
"""

import os

from haulcast.config.env import ConfigError, database_from_url
from haulcast.config.settings import *

_test_database_url = os.environ.get("TEST_DATABASE_URL", "").strip()
if not _test_database_url:
    raise ConfigError(
        "TEST_DATABASE_URL is required: run `bash scripts/dev-db.sh start`, "
        'then `export "$(bash scripts/dev-db.sh url)"`.',
    )

DATABASES = {"default": database_from_url(_test_database_url)}
SECRET_KEY = "test-only-secret-key-never-used-outside-the-test-suite-0123456789"  # noqa: S105
DEBUG = False
HAULCAST_COMMIT = "0000000"
