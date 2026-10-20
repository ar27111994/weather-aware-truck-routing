"""Single-flight leases: the table behind ``haulcast.services.single_flight``.

``single_flight_lease`` has one row per piece of work somebody is computing right now; the row is
a lease that expires, so a crashed leader frees the work by itself. Like every table it carries
row level security for the runtime role, and ``app.cleanup_expired`` now deletes expired leases
too (a leader that dies between claiming and releasing leaves a row behind for a day at most).
"""

from django.db import migrations, models

_FUNCTION = """
CREATE OR REPLACE FUNCTION app.cleanup_expired()
RETURNS TABLE (table_name text, deleted bigint)
LANGUAGE plpgsql
AS $body$
DECLARE
    v_now timestamptz := clock_timestamp();
BEGIN
    FOREACH table_name IN ARRAY ARRAY[{tables}] LOOP
        EXECUTE format('DELETE FROM app.%I WHERE expires_at < $1', table_name) USING v_now;
        GET DIAGNOSTICS deleted = ROW_COUNT;
        RETURN NEXT;
    END LOOP;
END
$body$
"""

_BEFORE = (
    "'geocode_cache', 'route_cache', 'weather_cache', 'plan', 'rate_limit_bucket', "
    "'upstream_budget'"
)
_AFTER = f"{_BEFORE}, 'single_flight_lease'"

FORWARD: tuple[str, ...] = (
    "ALTER TABLE app.single_flight_lease ENABLE ROW LEVEL SECURITY",
    (
        "CREATE POLICY haulcast_app_all ON app.single_flight_lease "
        "FOR ALL TO haulcast_app USING (true) WITH CHECK (true)"
    ),
    _FUNCTION.format(tables=_AFTER),
)

BACKWARD: tuple[str, ...] = (
    _FUNCTION.format(tables=_BEFORE),
    "DROP POLICY IF EXISTS haulcast_app_all ON app.single_flight_lease",
)


class Migration(migrations.Migration):
    dependencies = [("store", "0005_retire_hourly_cleanup_job")]

    operations = [
        migrations.CreateModel(
            name="SingleFlightLease",
            fields=[
                ("key", models.CharField(max_length=64, primary_key=True, serialize=False)),
                ("holder", models.CharField(max_length=32)),
                ("expires_at", models.DateTimeField()),
            ],
            options={"db_table": "single_flight_lease"},
        ),
        migrations.AddIndex(
            model_name="singleflightlease",
            index=models.Index(fields=["expires_at"], name="single_flight_lease_expires_idx"),
        ),
        migrations.RunSQL(sql=FORWARD, reverse_sql=BACKWARD),
    ]
