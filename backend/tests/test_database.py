"""The suite runs against a REAL Postgres of the same major version as Supabase (decision D-10)."""

import pytest
from django.db import connection

SUPABASE_POSTGRES_MAJOR = 17
POSTGRES_MAJOR_DIVISOR = 10_000  # server_version_num = major * 10000 + minor (PostgreSQL >= 10)


@pytest.mark.django_db
def test_suite_runs_against_postgres_matching_supabase() -> None:
    assert connection.vendor == "postgresql"

    with connection.cursor() as cursor:
        cursor.execute("SELECT current_setting('server_version_num')::int")
        row = cursor.fetchone()

    assert row is not None
    assert row[0] // POSTGRES_MAJOR_DIVISOR == SUPABASE_POSTGRES_MAJOR
