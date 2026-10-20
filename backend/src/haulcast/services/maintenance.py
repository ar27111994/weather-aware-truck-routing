"""Maintenance: delete expired rows and prove the database is reachable.

Run daily by Vercel Cron (through ``/api/v1/internal/maintenance``) and hourly by pg_cron where
available. Besides the housekeeping it is a real database round trip, which is what keeps a free
Supabase project from being paused for inactivity. All logic is the SQL function
``app.cleanup_expired``, so both triggers share one implementation.
"""

from django.db import connection


def run_cleanup() -> dict[str, int]:
    """Delete every expired row and return ``{table: rows deleted}``."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT table_name, deleted FROM app.cleanup_expired()")
        return {str(table): int(deleted) for table, deleted in cursor.fetchall()}
