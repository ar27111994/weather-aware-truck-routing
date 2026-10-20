"""Create or update the Haulcast database roles and the ``app`` schema (idempotent, all-or-nothing).

Run it once per database with an *administrator* connection (never with the runtime role), before
the first migration and again whenever a role password changes::

    export DATABASE_URL=... HAULCAST_OWNER_DB_PASSWORD=... HAULCAST_APP_DB_PASSWORD=...
    uv run python scripts/bootstrap_db.py

``DATABASE_URL`` is the administrator DSN (on Supabase: the ``postgres.<project-ref>`` user through
the session pooler); the two passwords are the ones the ``haulcast_owner`` (DDL) and
``haulcast_app`` (runtime DML) roles get. Nothing is printed except role names and a verdict:
never a DSN or a password. See ``haulcast.store.bootstrap`` for the privilege model it creates and
verifies.

The logic lives in the package, where it is imported, typed and tested like every other module;
this file only gives deployments and CI the path the runbooks name.
"""

from haulcast.store.bootstrap import main

if __name__ == "__main__":
    raise SystemExit(main())
