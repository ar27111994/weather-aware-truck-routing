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

FLIGHT_LEASE_S: Final = 30.0
"""How long a single-flight leader may run before others take its work over.

A leader's work is bounded by the request deadline (25 s at most), so a healthy leader is never
taken over, and a crashed one blocks nobody for longer than this.
"""

FLIGHT_WAIT_S: Final = 25.0
"""Longest a caller waits for somebody else's work; the request deadline cuts it shorter."""

PLAN_BUDGET_S: Final = 25.0
"""Wall-clock budget of one plan request (API-CONTRACT); upstream calls are cut to what is left."""

HEATMAP_BUDGET_S: Final = 25.0
"""Wall-clock budget of one heatmap computation (one weather fetch, then scoring)."""

GEOCODE_BUDGET_S: Final = 3.5
"""Wall-clock budget of one geocoding request: place search is interactive, search-as-you-type.

T14 measured Photon at 6.7 s for an uncached query from iad1 (17.6 s for the first call, with the
old 8 s read timeout and two retries) and Open-Meteo geocoding at 1.0 to 1.4 s. A search that may
wait for a provider as long as a plan does would be unusable, so the whole search, the cache miss
and every provider it tries, ends inside this budget.
"""

GEOCODE_ATTEMPT_S: Final = 2.0
"""Longest one geocoding provider may take: a single bounded attempt, no retries.

The next provider is the retry. With :data:`GEOCODE_BUDGET_S` the second provider is always left at
least ``GEOCODE_BUDGET_S - GEOCODE_ATTEMPT_S`` seconds.
"""

FUNCTION_HEADROOM_S: Final = 2.0
"""Least headroom ``maxDuration`` must leave above the worst case.

The interpreter, the framework and serialising the answer take time that no budget above covers.
"""


def worst_case_request_s() -> float:
    """Return the longest a plan request can take when every layer uses its whole budget.

    The request's one database connection opens (``DB_CONNECT_TIMEOUT_S``), the rate limiter's
    statement runs (``DB_STATEMENT_TIMEOUT_S``), all upstream work ends at the request's deadline
    (``PLAN_BUDGET_S``; a heatmap has ``HEATMAP_BUDGET_S``, a search ``GEOCODE_BUDGET_S``) and one
    more statement stores the answer. ``docs/BACKEND.md`` ("Time budgets") shows the same sum as a
    table and ``tests/test_timeouts.py`` pins the two to each other and to ``vercel.json``.

    The sum assumes the database answers or fails: a failed statement ends the request with 503, so
    at most one statement per phase runs into its timeout.
    """
    longest_work = max(PLAN_BUDGET_S, HEATMAP_BUDGET_S, GEOCODE_BUDGET_S)
    return DB_CONNECT_TIMEOUT_S + DB_STATEMENT_TIMEOUT_S + longest_work + DB_STATEMENT_TIMEOUT_S
