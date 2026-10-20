"""Every time budget of the backend, in one place.

The numbers are chosen together: a request must finish (or fail cleanly) inside the serverless
function's ``maxDuration`` however the upstreams and the database behave, so each layer below gets
a budget and ``docs/BACKEND.md`` ("Time budgets") adds them up. ``tests/test_timeouts.py`` pins
the relationships, and ``vercel.json`` is checked against them.
"""

from typing import Final

DB_CONNECT_TIMEOUT_S: Final = 3
"""Longest wait to open a connection as the runtime role (libpq ``connect_timeout``, whole seconds).

Without it psycopg waits up to 130 s, longer than any function lives, so the documented degraded
modes (the in-process rate limiter, the readiness 503) would never get to run.
"""

DB_MIGRATION_CONNECT_TIMEOUT_S: Final = 5
"""The same bound for the owner connection used by migrations (a CI job, nobody is waiting)."""

DB_STATEMENT_TIMEOUT_S: Final = 5
"""Server-side ``statement_timeout`` of the runtime role (every statement is a point lookup)."""

DB_IDLE_IN_TRANSACTION_TIMEOUT_S: Final = 10
"""Server-side ``idle_in_transaction_session_timeout`` of the runtime role.

No transaction of ours spans an upstream call, so one idle this long was abandoned by a request
that died; the server then rolls it back and frees the pooler connection.
"""

DB_MAINTENANCE_STATEMENT_TIMEOUT_S: Final = 20
"""``statement_timeout`` of the daily cleanup transaction (it deletes a day's worth of rows)."""
