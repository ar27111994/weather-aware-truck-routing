"""SQL functions: atomic GCRA rate limiting, upstream budgets and expired-row cleanup.

``app.rate_limit_take`` / ``app.upstream_budget_take`` implement the generic cell rate algorithm
(GCRA, a token bucket stored as one timestamp: the *theoretical arrival time*, TAT) in ONE
statement, ``INSERT ... ON CONFLICT DO UPDATE ... RETURNING``. The row lock taken by the upsert
serialises concurrent callers on the same key and the ``DO UPDATE`` re-evaluates its decision
against the latest committed row, so the number of allowed calls is exact under any concurrency.

A bucket of ``p_burst`` tokens refills one token every ``p_period / p_rate``; taking ``p_cost``
tokens is allowed iff the TAT after the take is at most ``p_burst`` emission intervals ahead of now.
The result is ``(allowed, retry_after_ms, remaining, reset_after_ms)``: how long until the denied
cost would fit, how many tokens are left, and how long until the bucket is full again.

``app.cleanup_expired`` deletes every row past its ``expires_at`` and is shared by the maintenance
endpoint and the hourly pg_cron job. All functions run with the caller's rights (SECURITY INVOKER):
the runtime role needs, and has, plain DML on the tables.
"""

from django.db import migrations

_SIGNATURE = "text, integer, interval, integer, integer"

_TAKE_FUNCTION = """
CREATE OR REPLACE FUNCTION app.{function}(
    p_key text,
    p_rate integer,
    p_period interval,
    p_burst integer,
    p_cost integer DEFAULT 1
) RETURNS TABLE (allowed boolean, retry_after_ms integer, remaining integer, reset_after_ms integer)
LANGUAGE plpgsql
AS $body$
DECLARE
    v_now timestamptz := clock_timestamp();
    v_interval_ms double precision;
    v_burst_ms double precision;
    v_cost_ms double precision;
    v_tat timestamptz;
    v_allowed boolean;
    v_backlog_ms double precision;
BEGIN
    IF p_rate < 1 OR p_burst < 1 OR p_cost < 1 OR p_cost > p_burst
       OR p_period <= interval '0' THEN
        RAISE EXCEPTION 'invalid rate limit parameters' USING ERRCODE = '22023';
    END IF;
    v_interval_ms := extract(epoch FROM p_period)::double precision * 1000.0 / p_rate;
    v_burst_ms := p_burst * v_interval_ms;
    v_cost_ms := p_cost * v_interval_ms;

    INSERT INTO app.{table} AS b (key, tat, last_allowed, updated_at, expires_at)
    VALUES (
        p_key,
        v_now + v_cost_ms * interval '1 millisecond',
        true,
        v_now,
        v_now + v_cost_ms * interval '1 millisecond' + interval '10 minutes'
    )
    ON CONFLICT (key) DO UPDATE SET
        last_allowed = greatest(b.tat, v_now) + v_cost_ms * interval '1 millisecond'
                       <= v_now + v_burst_ms * interval '1 millisecond',
        tat = CASE
            WHEN greatest(b.tat, v_now) + v_cost_ms * interval '1 millisecond'
                 <= v_now + v_burst_ms * interval '1 millisecond'
            THEN greatest(b.tat, v_now) + v_cost_ms * interval '1 millisecond'
            ELSE b.tat
        END,
        updated_at = v_now,
        expires_at = greatest(b.tat, v_now) + v_cost_ms * interval '1 millisecond'
                     + interval '10 minutes'
    RETURNING b.tat, b.last_allowed INTO v_tat, v_allowed;

    v_backlog_ms := greatest(extract(epoch FROM (v_tat - v_now)) * 1000.0, 0);
    allowed := v_allowed;
    remaining := greatest(floor((v_burst_ms - v_backlog_ms) / v_interval_ms), 0)::integer;
    reset_after_ms := least(ceil(v_backlog_ms), 2147483647)::integer;
    IF v_allowed THEN
        retry_after_ms := 0;
    ELSE
        retry_after_ms := least(ceil(v_backlog_ms + v_cost_ms - v_burst_ms), 2147483647)::integer;
    END IF;
    RETURN NEXT;
END
$body$
"""

_CLEANUP_FUNCTION = """
CREATE OR REPLACE FUNCTION app.cleanup_expired()
RETURNS TABLE (table_name text, deleted bigint)
LANGUAGE plpgsql
AS $body$
DECLARE
    v_now timestamptz := clock_timestamp();
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'geocode_cache', 'route_cache', 'weather_cache', 'plan',
        'rate_limit_bucket', 'upstream_budget'
    ] LOOP
        EXECUTE format('DELETE FROM app.%I WHERE expires_at < $1', table_name) USING v_now;
        GET DIAGNOSTICS deleted = ROW_COUNT;
        RETURN NEXT;
    END LOOP;
END
$body$
"""

_FUNCTIONS = (
    ("rate_limit_take", "rate_limit_bucket"),
    ("upstream_budget_take", "upstream_budget"),
)


def _grants(signature: str) -> list[str]:
    return [
        f"REVOKE EXECUTE ON FUNCTION {signature} FROM PUBLIC",
        f"GRANT EXECUTE ON FUNCTION {signature} TO haulcast_app",
    ]


FORWARD: tuple[str, ...] = (
    *(
        statement
        for function, table in _FUNCTIONS
        for statement in (
            _TAKE_FUNCTION.format(function=function, table=table),
            *_grants(f"app.{function}({_SIGNATURE})"),
        )
    ),
    _CLEANUP_FUNCTION,
    *_grants("app.cleanup_expired()"),
)

BACKWARD: tuple[str, ...] = (
    "DROP FUNCTION IF EXISTS app.cleanup_expired()",
    *(f"DROP FUNCTION IF EXISTS app.{function}({_SIGNATURE})" for function, _ in _FUNCTIONS),
)


class Migration(migrations.Migration):
    dependencies = [("store", "0002_row_level_security")]

    operations = [migrations.RunSQL(sql=FORWARD, reverse_sql=BACKWARD)]
