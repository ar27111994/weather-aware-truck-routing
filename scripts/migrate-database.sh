#!/usr/bin/env bash
# Apply the database bootstrap (roles, schema, grants) and the Django migrations with the OWNER
# connection. Run by deploy.yml before a production deployment is promoted; safe to re-run.
#
# usage: DATABASE_URL=<owner DSN through the Supabase session pooler> scripts/migrate-database.sh
# The bootstrap module reads the remaining variables (HAULCAST_APP_DB_PASSWORD, ...) from the
# environment, exactly as listed in .env.example.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../backend"
: "${DATABASE_URL:?DATABASE_URL (owner DSN through the session pooler) is required}"

uv run python -m haulcast.store.bootstrap
uv run python manage.py migrate --noinput
