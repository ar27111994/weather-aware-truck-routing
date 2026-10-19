#!/usr/bin/env bash
# Local PostgreSQL for development and tests (decision D-10: no Docker, no system-wide Postgres).
#
# usage: scripts/dev-db.sh init|start|stop|status|url|run <command...>
#
#   init     create the data directory (idempotent)
#   start    init if needed, start the server and make sure the dev database exists (idempotent)
#   stop     stop the server if it is running (idempotent)
#   status   report whether the server is running (exit 0 = running, 3 = stopped)
#   url      print TEST_DATABASE_URL=<url>   (use: export "$(scripts/dev-db.sh url)")
#   run      start the server if needed, then run <command...> with TEST_DATABASE_URL exported
#
# Binaries: portable EDB PostgreSQL 17 (same major as the Supabase project) unpacked OUTSIDE the
# repo at C:/Tools/pgsql-17; point PG_HOME elsewhere for another location or platform.
# Data lives in the gitignored .local/pg, the server listens on 127.0.0.1:54329 only, trust auth.
# Durability is switched off (fsync, synchronous_commit, full_page_writes): this is a throwaway
# test/dev database, so speed beats crash safety.
set -euo pipefail

readonly PG_MAJOR=17
readonly PG_HOME="${PG_HOME:-C:/Tools/pgsql-${PG_MAJOR}}"
readonly PORT="${DEV_DB_PORT:-54329}"
readonly DB_NAME="haulcast"
readonly DB_USER="postgres"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
readonly DATA_DIR="${DEV_DB_DATA_DIR:-$ROOT/.local/pg}"
readonly LOG_FILE="${DEV_DB_LOG_FILE:-$ROOT/.local/pg.log}"

die() {
  echo "dev-db: $*" >&2
  exit 1
}

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//' >&2
}

# Native tools on Windows need C:/-style paths; MSYS paths (/c/...) pass through cygpath.
native() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s' "$1"
  fi
}

# Run a PostgreSQL binary from PG_HOME/bin.
pg() {
  local tool="$1"
  shift
  "$PG_HOME/bin/$tool" "$@"
}

require_binaries() {
  pg pg_ctl --version >/dev/null 2>&1 ||
    die "PostgreSQL ${PG_MAJOR} binaries not found at ${PG_HOME} (set PG_HOME; see README 'Local development')"
}

is_running() {
  pg pg_ctl -D "$(native "$DATA_DIR")" status >/dev/null 2>&1
}

ensure_database() {
  local exists
  exists="$(pg psql -h 127.0.0.1 -p "$PORT" -U "$DB_USER" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | tr -d '\r')"
  if [ "$exists" != "1" ]; then
    pg createdb -h 127.0.0.1 -p "$PORT" -U "$DB_USER" "$DB_NAME"
    echo "dev-db: created database ${DB_NAME}"
  fi
}

cmd_init() {
  require_binaries
  if [ -f "$DATA_DIR/PG_VERSION" ]; then
    echo "dev-db: data directory already initialised at ${DATA_DIR}"
    return 0
  fi
  mkdir -p "$DATA_DIR"
  pg initdb -D "$(native "$DATA_DIR")" -U "$DB_USER" -A trust -E UTF8 --locale=C >/dev/null
  echo "dev-db: initialised PostgreSQL ${PG_MAJOR} data directory at ${DATA_DIR}"
}

cmd_start() {
  cmd_init
  if is_running; then
    echo "dev-db: already running on 127.0.0.1:${PORT}"
  else
    mkdir -p "$(dirname "$LOG_FILE")"
    pg pg_ctl -D "$(native "$DATA_DIR")" -l "$(native "$LOG_FILE")" -w -t 60 \
      -o "-p ${PORT} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off" \
      start >/dev/null
    echo "dev-db: started on 127.0.0.1:${PORT}"
  fi
  ensure_database
}

cmd_stop() {
  require_binaries
  if is_running; then
    pg pg_ctl -D "$(native "$DATA_DIR")" -m fast -w stop >/dev/null
    echo "dev-db: stopped"
  else
    echo "dev-db: not running"
  fi
}

cmd_status() {
  require_binaries
  if is_running; then
    echo "dev-db: running on 127.0.0.1:${PORT} (data: ${DATA_DIR})"
  else
    echo "dev-db: stopped"
    return 3
  fi
}

cmd_url() {
  printf 'TEST_DATABASE_URL=postgresql://%s@127.0.0.1:%s/%s\n' "$DB_USER" "$PORT" "$DB_NAME"
}

cmd_run() {
  [ "$#" -gt 0 ] || die "run needs a command, e.g. scripts/dev-db.sh run uv run pytest"
  cmd_start >&2
  export "$(cmd_url)"
  exec "$@"
}

case "${1:-}" in
  init) cmd_init ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  url) cmd_url ;;
  run)
    shift
    cmd_run "$@"
    ;;
  *)
    usage
    exit 2
    ;;
esac
