#!/usr/bin/env bash
# Bootstrap the database (roles, schema, grants), then apply the Django migrations as the schema
# owner. Run by deploy.yml before a production deployment is promoted; safe to re-run.
#
# usage: DATABASE_URL=... HAULCAST_OWNER_DB_PASSWORD=... HAULCAST_APP_DB_PASSWORD=... \
#          scripts/migrate-database.sh
# DATABASE_URL is the administrator DSN through the Supabase session pooler (port 5432). Every
# variable is listed in .env.example; none is ever printed.
#
# Two identities on purpose (docs/BACKEND.md, "Role model"): the bootstrap needs the administrator
# connection to create the roles, and the migrations must run as the DDL role haulcast_owner
# (--database=owner). Plain `manage.py migrate` would use the runtime role haulcast_app, which has
# no DDL rights. The bootstrap runs through scripts/bootstrap_db.py, the entry point the runbooks
# name: `python -m haulcast.store.bootstrap` imports the module and exits 0 without doing anything.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../backend"
: "${DATABASE_URL:?DATABASE_URL (administrator DSN through the session pooler) is required}"

uv run python scripts/bootstrap_db.py
uv run python manage.py migrate --noinput --database=owner
