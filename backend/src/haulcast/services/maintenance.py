"""Maintenance: delete expired rows and prove the database is reachable.

Run daily by Vercel Cron (through ``/api/v1/internal/maintenance``): the only cleanup there is
(decision D-32 retired the hourly pg_cron job). Besides the housekeeping it is a real database
round trip, which is what keeps a free Supabase project from being paused for inactivity. All
logic is the SQL function ``app.cleanup_expired``.
"""

from django.db import connection, transaction

from haulcast.config.timeouts import DB_MAINTENANCE_STATEMENT_TIMEOUT_S


def run_cleanup() -> dict[str, int]:
    """Delete every expired row and return ``{table: rows deleted}``.

    The runtime role's ``statement_timeout`` (5 s) fits point lookups, not a day's worth of
    deletes, so this one transaction gets a larger budget. ``SET LOCAL`` ends with the
    transaction and, unlike a function-level setting, applies to the statement that follows.
    """
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(f"SET LOCAL statement_timeout = '{DB_MAINTENANCE_STATEMENT_TIMEOUT_S}s'")
        cursor.execute("SELECT table_name, deleted FROM app.cleanup_expired()")
        return {str(table): int(deleted) for table, deleted in cursor.fetchall()}
