#!/usr/bin/env bash
# Start the whole stack for local development: Postgres, the Django API and the Vite dev server.
#
#   API  http://127.0.0.1:8000/api/v1/   (Django dev server, auto-reload)
#   Web  http://127.0.0.1:5173/          (Vite; proxies /api to the API, like Vercel does in prod)
#
# Configuration comes from the environment: copy .env.example to .env.local, fill it in and export
# it, or at least set DEBUG=true and ALLOWED_HOSTS=localhost,127.0.0.1. Ctrl-C stops everything.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

bash scripts/dev-db.sh start

# Reap both servers (and Postgres stays up: stop it explicitly with scripts/dev-db.sh stop).
trap 'kill 0' EXIT INT TERM

(cd backend && DEBUG="${DEBUG:-true}" ALLOWED_HOSTS="${ALLOWED_HOSTS:-localhost,127.0.0.1}" \
  uv run python manage.py runserver 127.0.0.1:8000) &
(cd frontend && pnpm dev --host 127.0.0.1 --port 5173) &

wait
