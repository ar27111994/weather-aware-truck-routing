"""Row level security on every table: only ``haulcast_app`` may read or write them.

Supabase's automatic RLS trigger only covers the ``public`` schema, so tables created by migrations
are *not* protected by default. Enabling RLS (and giving the runtime role an explicit policy) makes
the data inaccessible to every other non-owner role even if a grant is ever added by mistake: it is
defense in depth next to the schema-level REVOKEs of ``bootstrap_db.py``. The owner role bypasses
RLS (it is not ``FORCE``d), which migrations and maintenance rely on.

Django's own ``django_migrations`` table is created by the owner with default privileges for the
runtime role; the runtime has no business touching migration history, so its access is revoked and
RLS (without any policy) closes it for everyone but the owner.
"""

from django.db import migrations

TABLES = (
    "geocode_cache",
    "route_cache",
    "weather_cache",
    "plan",
    "rate_limit_bucket",
    "upstream_budget",
)

REQUIRE_BOOTSTRAP = """
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'haulcast_app') THEN
        RAISE EXCEPTION
            'role haulcast_app does not exist: run backend/scripts/bootstrap_db.py first';
    END IF;
END
$$
"""


def _enable_rls(table: str) -> list[str]:
    return [
        f"ALTER TABLE app.{table} ENABLE ROW LEVEL SECURITY",
        (
            f"CREATE POLICY haulcast_app_all ON app.{table} "
            "FOR ALL TO haulcast_app USING (true) WITH CHECK (true)"
        ),
    ]


def _disable_rls(table: str) -> list[str]:
    return [
        f"DROP POLICY IF EXISTS haulcast_app_all ON app.{table}",
        f"ALTER TABLE app.{table} DISABLE ROW LEVEL SECURITY",
    ]


FORWARD: tuple[str, ...] = (
    REQUIRE_BOOTSTRAP,
    *(statement for table in TABLES for statement in _enable_rls(table)),
    "REVOKE ALL ON TABLE app.django_migrations FROM haulcast_app",
    "ALTER TABLE app.django_migrations ENABLE ROW LEVEL SECURITY",
)

BACKWARD: tuple[str, ...] = (
    "ALTER TABLE app.django_migrations DISABLE ROW LEVEL SECURITY",
    *(statement for table in reversed(TABLES) for statement in _disable_rls(table)),
)


class Migration(migrations.Migration):
    dependencies = [("store", "0001_initial")]

    operations = [migrations.RunSQL(sql=FORWARD, reverse_sql=BACKWARD)]
