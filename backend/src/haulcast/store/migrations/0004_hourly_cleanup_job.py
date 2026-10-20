"""Schedule the hourly expired-row cleanup with pg_cron, when the extension is available.

Supabase offers pg_cron; a plain PostgreSQL (the local test server, CI) does not. The migration is
a no-op unless the ``cron`` schema exists and the migrating role may call ``cron.schedule`` (the
bootstrap script grants it on Supabase), so the same migration set works everywhere. Scheduling is
by job *name*, which makes re-running it idempotent: pg_cron replaces a job with the same name. The
job runs as the scheduling role, ``haulcast_owner``, which owns the tables.

The daily Vercel cron calling ``/api/v1/internal/maintenance`` performs the same cleanup and is
also what keeps a free Supabase project from being paused for inactivity.
"""

from django.db import migrations

# The guards are NESTED on purpose: PostgreSQL parses and plans a whole boolean expression before it
# evaluates any operand, so ``... AND EXISTS (SELECT FROM cron.job ...)`` fails with "relation does
# not exist" on a server without pg_cron even when an earlier operand is false. A separate ``IF``
# is only planned once the previous guard has passed.
SCHEDULE = """
DO $$
BEGIN
    IF to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
        IF has_function_privilege(current_user, 'cron.schedule(text,text,text)', 'EXECUTE') THEN
            PERFORM cron.schedule(
                'haulcast-cleanup', '7 * * * *', 'SELECT * FROM app.cleanup_expired()'
            );
        END IF;
    END IF;
END
$$
"""

UNSCHEDULE = """
DO $$
BEGIN
    IF to_regprocedure('cron.unschedule(text)') IS NOT NULL THEN
        IF has_function_privilege(current_user, 'cron.unschedule(text)', 'EXECUTE') THEN
            IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'haulcast-cleanup') THEN
                PERFORM cron.unschedule('haulcast-cleanup');
            END IF;
        END IF;
    END IF;
END
$$
"""


class Migration(migrations.Migration):
    dependencies = [("store", "0003_rate_limit_and_cleanup_functions")]

    operations = [migrations.RunSQL(sql=(SCHEDULE,), reverse_sql=(UNSCHEDULE,))]
