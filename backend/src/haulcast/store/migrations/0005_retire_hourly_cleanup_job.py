"""Retire the hourly pg_cron cleanup job: the daily Vercel Cron call is the only cleanup.

Decision D-32 (independent review R2, section 5.1). The hourly job that migration ``0004`` may have
scheduled was half-working: it ran as the owner role over a local libpq connection that Supabase
may not allow, enabling the extension later scheduled nothing (the applied ``0004`` never re-runs),
and ``cron.job_run_details`` is never cleaned. The daily call to ``/api/v1/internal/maintenance`` is
mandatory anyway (it is the keep-alive that stops a free project pausing), is idempotent and safe
under concurrent runs, and bounds table growth well inside the free plan (``docs/BACKEND.md``).

This migration unschedules the job wherever one exists. ``0004`` is applied on real databases and is
never edited; this is its successor. The guards follow decision D-10 and are **nested** (each ``IF``
is only planned once the previous guard passed, so a server without pg_cron never sees a reference
to ``cron.*``), and the schema-privilege guard comes first: with the ``cron`` schema present but no
``USAGE`` on it, even *looking up* a function raises "permission denied for schema cron", although
``EXECUTE`` on the function itself is granted to PUBLIC by default.

Reversing it does nothing: there is deliberately no way back to an hourly job.
"""

from django.db import migrations

UNSCHEDULE = """
DO $$
BEGIN
    IF to_regnamespace('cron') IS NOT NULL THEN
        IF has_schema_privilege(current_user, 'cron', 'USAGE') THEN
            IF to_regprocedure('cron.unschedule(text)') IS NOT NULL THEN
                IF has_function_privilege(current_user, 'cron.unschedule(text)', 'EXECUTE') THEN
                    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'haulcast-cleanup') THEN
                        PERFORM cron.unschedule('haulcast-cleanup');
                    END IF;
                END IF;
            END IF;
        END IF;
    END IF;
END
$$
"""


class Migration(migrations.Migration):
    dependencies = [("store", "0004_hourly_cleanup_job")]

    operations = [migrations.RunSQL(sql=(UNSCHEDULE,), reverse_sql=migrations.RunSQL.noop)]
