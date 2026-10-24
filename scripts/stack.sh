#!/usr/bin/env bash
# Local prod-like stack: Postgres, the migrated schema, Django on waitress and the production build
# of the frontend behind a gateway that proxies /api, the way Vercel serves this repository. Nothing
# here talks to a third party: the backend runs in replay mode and answers from recorded fixtures
# (docs/STACK.md).
#
# usage: scripts/stack.sh up [--foreground] | down | status | reset | env | logs [django|gateway] | smoke
#
#   up        start everything and wait until /api/v1/health/ready answers through the gateway; with
#             --foreground stay in front and stop the services on SIGTERM or Ctrl-C
#   down      stop what `up` started: by pid, never by process name, never the database server
#   status    say what runs (exit 0: both services answer, 3: they do not)
#   reset     down, drop the stack database and forget the generated settings
#   env       print the clock, the URLs and the prefilled links, one NAME=value per line
#   logs      print the last lines of the log of one service, or of both
#   smoke     check the running stack through the gateway (curl and jq)
#
# Settings, all optional:
#   STACK_GATEWAY_PORT   the gateway, which the browser and the e2e use      (default 4210)
#   STACK_DJANGO_PORT    Django on waitress, behind the gateway              (default 8110)
#   STACK_DATABASE_NAME  the database of the stack                           (default haulcast_stack)
#   STACK_DATABASE_URL   administrator DSN of the Postgres server to use; its database is ignored.
#                        Unset: the portable Postgres of scripts/dev-db.sh (started if it is down).
#   STACK_REPLAY_NOW     the instant the backend believes it is: ISO 8601 with an offset, for example
#                        2026-10-24T05:30:00Z. Unset: the current UTC minute, read once at `up`.
#   STACK_STATE_DIR      pid files, logs and the generated settings        (default .local/stack)
#   STACK_CLIENT_DIR     the production build to serve                     (default frontend/build/client)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
readonly HOST="127.0.0.1"
readonly READY_TIMEOUT_S=120
readonly LOG_TAIL_LINES=100
readonly STOP_TIMEOUT_S=10
readonly DEPARTURE_OFFSET_S=3600
readonly LOAD_WEIGHT_LB=38000
readonly BURST_REQUESTS=15
readonly SERVICES=(django gateway)

GATEWAY_PORT="${STACK_GATEWAY_PORT:-4210}"
DJANGO_PORT="${STACK_DJANGO_PORT:-8110}"
DATABASE_NAME="${STACK_DATABASE_NAME:-haulcast_stack}"
STATE_DIR="${STACK_STATE_DIR:-$ROOT/.local/stack}"
CLIENT_DIR="${STACK_CLIENT_DIR:-$ROOT/frontend/build/client}"
ENV_FILE="$STATE_DIR/env"

# The recorded trips (backend/tests/fixtures/providers; docs/STACK.md has the table of what each
# scenario does to them): trip | origin | its lat,lon | destination | its lat,lon | scenario to show.
readonly TRIP_TABLE=(
  "slc-den|Salt Lake City, Utah, United States|40.7608,-111.891|Denver, Colorado, United States|39.7392,-104.9903|storm-on-fastest"
  "chi-den|Chicago, Illinois, United States|41.8781,-87.6298|Denver, Colorado, United States|39.7392,-104.9903|storm-on-fastest"
  "newark-jc|Newark, New Jersey, United States|40.7357,-74.1724|Jersey City, New Jersey, United States|40.7178,-74.0431|high-wind-corridor"
  "la-phx|Los Angeles, California, United States|34.0522,-118.2437|Phoenix, Arizona, United States|33.4484,-112.074|calm"
)

# ---------------------------------------------------------------------------------------- helpers

die() {
  echo "stack: $*" >&2
  exit 1
}

say() {
  echo "stack: $*"
}

usage() {
  echo "usage: scripts/stack.sh up [--foreground] | down | status | reset | env | logs [django|gateway] | smoke" >&2
  exit 2
}

# Native tools on Windows need C:/-style paths; MSYS paths (/c/...) pass through cygpath.
native() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s' "$1"
  fi
}

gateway_url() {
  printf 'http://%s:%s' "$HOST" "$GATEWAY_PORT"
}

tcp_open() {
  (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null
}

random_hex() {
  head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
}

current_minute() {
  date -u +%Y-%m-%dT%H:%M:00Z
}

validate_port() {
  local name="$1" value="$2"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
    die "$name must be a port number, got \"$value\""
  fi
}

validate_settings() {
  local instant_pattern='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$'
  validate_port STACK_GATEWAY_PORT "$GATEWAY_PORT"
  validate_port STACK_DJANGO_PORT "$DJANGO_PORT"
  if [ "$GATEWAY_PORT" = "$DJANGO_PORT" ]; then
    die "STACK_GATEWAY_PORT and STACK_DJANGO_PORT must differ, both are $GATEWAY_PORT"
  fi
  if [[ ! "$DATABASE_NAME" =~ ^[a-z][a-z0-9_]{0,62}$ ]]; then
    die "STACK_DATABASE_NAME must be lower-case letters, digits and underscores, starting with a letter, got \"$DATABASE_NAME\""
  fi
  if [ -n "${STACK_REPLAY_NOW:-}" ]; then
    if [[ ! "$STACK_REPLAY_NOW" =~ $instant_pattern ]] || ! date -d "$STACK_REPLAY_NOW" +%s >/dev/null 2>&1; then
      die "STACK_REPLAY_NOW must be an ISO 8601 instant with an offset, for example 2026-10-24T05:30:00Z, got \"$STACK_REPLAY_NOW\""
    fi
  fi
}

# ----------------------------------------------------------------------- processes (pid files)

pid_file() {
  printf '%s/%s.pid' "$STATE_DIR" "$1"
}

read_pid() {
  if [ -f "$(pid_file "$1")" ]; then
    tr -d '\r\n' <"$(pid_file "$1")"
  fi
}

is_alive() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null
}

service_port() {
  case "$1" in
    gateway) printf '%s' "$GATEWAY_PORT" ;;
    django) printf '%s' "$DJANGO_PORT" ;;
  esac
}

service_alive() {
  is_alive "$(read_pid "$1")"
}

wait_gone() {
  local pid="$1" deadline=$((SECONDS + $2))
  while is_alive "$pid"; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 0.2
  done
}

# Stops one service by the pid `up` wrote. A pid file that outlived its process (a reboot, a crash)
# must never make this kill an unrelated process that was given the same pid, so without `force` a
# process is stopped only while its port still answers.
stop_service() {
  local name="$1" force="${2:-}" pid
  pid="$(read_pid "$name")"
  if [ -z "$pid" ]; then
    return 0
  fi
  if is_alive "$pid" && { [ -n "$force" ] || tcp_open "$HOST" "$(service_port "$name")"; }; then
    kill "$pid" 2>/dev/null || true
    if ! wait_gone "$pid" "$STOP_TIMEOUT_S"; then
      kill -9 "$pid" 2>/dev/null || true
      wait_gone "$pid" "$STOP_TIMEOUT_S" || true
    fi
    say "stopped $name (pid $pid)"
  else
    say "$name was not running (pid file of pid $pid removed)"
  fi
  rm -f "$(pid_file "$name")"
}

# ------------------------------------------------------------------------- clock and prefilled links

env_file_value() {
  if [ -f "$ENV_FILE" ]; then
    sed -n "/^$1=/{s/^$1=//p;q;}" "$ENV_FILE" | tr -d '\r'
  fi
}

# The instant the backend believes it is: the one a running stack was started with, else the one
# `up` would choose now.
effective_replay_now() {
  local now=""
  if service_alive gateway; then
    now="$(env_file_value HAULCAST_REPLAY_NOW)"
  fi
  if [ -z "$now" ]; then
    now="${STACK_REPLAY_NOW:-$(current_minute)}"
  fi
  printf '%s' "$now"
}

# `now` plus seconds, as a UTC instant to the minute: the form the planner's links use.
departure() {
  local epoch
  epoch="$(date -d "$1" +%s)"
  date -u -d "@$((epoch + $2))" +%Y-%m-%dT%H:%MZ
}

# One prefilled planner link per trip (R9: the planner reads origin, destination, depart, load and
# scenario from the address). `env` prints them as NAME=value, `up` for a person.
print_links() {
  local now="$1" style="$2" depart row trip origin_label origin_coordinates destination_label
  local destination_coordinates scenario link name
  depart="$(departure "$now" "$DEPARTURE_OFFSET_S")"
  for row in "${TRIP_TABLE[@]}"; do
    IFS='|' read -r trip origin_label origin_coordinates destination_label destination_coordinates scenario <<<"$row"
    link="$(gateway_url)/?origin=${origin_label// /%20}@${origin_coordinates}&destination=${destination_label// /%20}@${destination_coordinates}&depart=${depart}&load=${LOAD_WEIGHT_LB}&scenario=${scenario}"
    if [ "$style" = env ]; then
      name="${trip^^}"
      echo "STACK_LINK_${name//-/_}=$link"
    else
      printf '  %-10s %-20s %s\n' "$trip" "$scenario" "$link"
    fi
  done
}

# -------------------------------------------------------------------------------------- database

# The administrator DSN of the server, with no database and no query: postgresql://user@host:port
server_url() {
  local url="${STACK_DATABASE_URL:-}"
  if [ -z "$url" ]; then
    url="$(bash "$ROOT/scripts/dev-db.sh" url | sed 's/^TEST_DATABASE_URL=//' | tr -d '\r')"
  fi
  if [[ ! "$url" =~ ^(postgres(ql)?://[^/?]+) ]]; then
    die "STACK_DATABASE_URL must look like postgresql://user@host:port/database"
  fi
  printf '%s' "${BASH_REMATCH[1]}"
}

database_url() {
  printf '%s/%s' "$(server_url)" "$1"
}

# The same database without credentials: where the runtime role connects (its own password is its).
database_coordinates() {
  local url
  url="$(database_url "$1")"
  if [[ "$url" =~ ^(postgres(ql)?://)([^/?]*@)?([^/?]+)/(.*)$ ]]; then
    printf '%s%s/%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[4]}" "${BASH_REMATCH[5]}"
  fi
}

server_host() {
  local authority="${1#*://}"
  authority="${authority##*@}"
  printf '%s' "${authority%%:*}"
}

server_port() {
  local authority="${1#*://}"
  authority="${authority##*@}"
  if [[ "$authority" == *:* ]]; then
    printf '%s' "${authority##*:}"
  else
    printf '5432'
  fi
}

server_reachable() {
  local url
  url="$(server_url)"
  tcp_open "$(server_host "$url")" "$(server_port "$url")"
}

# host:port of the server: what a message may say about it. The DSN itself may carry a password.
server_address() {
  local url
  url="$(server_url)"
  printf '%s:%s' "$(server_host "$url")" "$(server_port "$url")"
}

psql_binary() {
  if command -v psql >/dev/null 2>&1; then
    printf 'psql'
  else
    printf '%s/bin/psql' "${PG_HOME:-C:/Tools/pgsql-17}"
  fi
}

# psql against the maintenance database of the server: quiet, unaligned, stops at the first error.
run_psql() {
  "$(psql_binary)" "$(database_url postgres)" -X -q -v ON_ERROR_STOP=1 -tA "$@" | tr -d '\r'
}

ensure_database_server() {
  if server_reachable; then
    return 0
  fi
  if [ -n "${STACK_DATABASE_URL:-}" ]; then
    die "no database server answers at $(server_address) (STACK_DATABASE_URL)"
  fi
  say "starting the development Postgres (scripts/dev-db.sh)"
  bash "$ROOT/scripts/dev-db.sh" start
}

ensure_database() {
  local exists
  exists="$(run_psql -c "SELECT 1 FROM pg_database WHERE datname = '$DATABASE_NAME'")"
  if [ "$exists" != "1" ]; then
    run_psql -c "CREATE DATABASE $DATABASE_NAME" >/dev/null
    say "created database $DATABASE_NAME"
  fi
}

# ------------------------------------------------------------------------------ generated settings

# One NAME=value line that `. file` reads back as exactly that value. The settings file is sourced,
# so a value is shell text: the password of a DSN may hold $ & ; ( ) quotes, a space or a backslash.
env_line() {
  printf '%s=%q\n' "$1" "$2"
}

# Throw-away secrets: kept between runs (the roles live in the server and keep their passwords) and
# forgotten by `reset`. The file is generated and gitignored; nothing in it is ever printed.
write_env_file() {
  local now="$1" secret salt app_password owner_password
  secret="$(env_file_value DJANGO_SECRET_KEY)"
  salt="$(env_file_value RATE_LIMIT_SALT)"
  app_password="$(env_file_value HAULCAST_APP_DB_PASSWORD)"
  owner_password="$(env_file_value HAULCAST_OWNER_DB_PASSWORD)"
  [ -n "$secret" ] || secret="$(random_hex 32)"
  [ -n "$salt" ] || salt="$(random_hex 16)"
  [ -n "$app_password" ] || app_password="$(random_hex 24)"
  [ -n "$owner_password" ] || owner_password="$(random_hex 24)"
  mkdir -p "$STATE_DIR"
  (
    umask 077
    {
      env_line DATABASE_URL "$(database_url "$DATABASE_NAME")"
      env_line DATABASE_URL_POOLED "$(database_coordinates "$DATABASE_NAME")"
      env_line DJANGO_SECRET_KEY "$secret"
      env_line RATE_LIMIT_SALT "$salt"
      env_line HAULCAST_APP_DB_PASSWORD "$app_password"
      env_line HAULCAST_OWNER_DB_PASSWORD "$owner_password"
      env_line ALLOWED_HOSTS "127.0.0.1,localhost"
      env_line ALLOWED_ORIGINS "$(gateway_url)"
      env_line CLIENT_IP_HEADER "x-forwarded-for"
      env_line HAULCAST_PROVIDER_MODE "replay"
      env_line HAULCAST_REPLAY_NOW "$now"
    } >"$ENV_FILE"
  )
}

# ------------------------------------------------------------------------------------------ up

port_must_be_free() {
  if tcp_open "$HOST" "$2"; then
    die "port $2 is already in use ($1): the stack never moves to another port. Stop what holds it, or set STACK_GATEWAY_PORT and STACK_DJANGO_PORT"
  fi
}

require_tools() {
  local tool
  for tool in uv node curl; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
  done
  command -v "$(psql_binary)" >/dev/null 2>&1 || [ -x "$(psql_binary).exe" ] || die "psql is required (set PG_HOME to a PostgreSQL 17 install, see scripts/dev-db.sh)"
}

start_django() {
  (
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
    # The runtime connects as haulcast_app through the coordinates in DATABASE_URL_POOLED; the
    # administrator credentials and the owner password stay with the migration step.
    unset DATABASE_URL HAULCAST_OWNER_DB_PASSWORD
    cd "$ROOT/backend"
    # waitress 3 deletes x-forwarded-for (and the other proxy headers) from every request unless the
    # peer is a configured trusted proxy. The backend counts a client by that header, so with the
    # default every request would share the `unknown` bucket. The stack keeps the header exactly as
    # the client sent it (the gateway adds and rewrites nothing), the way Vercel hands it over.
    exec uv run waitress-serve "--listen=$HOST:$DJANGO_PORT" --threads=8 \
      --no-clear-untrusted-proxy-headers haulcast.config.wsgi:application
  ) >"$STATE_DIR/django.log" 2>&1 </dev/null &
  echo "$!" >"$(pid_file django)"
}

start_gateway() {
  (
    export E2E_PORT="$GATEWAY_PORT" STACK_DJANGO_PORT="$DJANGO_PORT"
    exec node "$(native "$ROOT/scripts/stack/gateway.mjs")" --dir "$(native "$CLIENT_DIR")" --host "$HOST"
  ) >"$STATE_DIR/gateway.log" 2>&1 </dev/null &
  echo "$!" >"$(pid_file gateway)"
}

# Waits until `url` answers 2xx; gives up when the service dies or the time is up.
wait_ready() {
  local name="$1" url="$2" deadline=$((SECONDS + READY_TIMEOUT_S))
  until curl -fsS --max-time 5 "$url" >/dev/null 2>&1; do
    if ! service_alive "$name"; then
      tail -n 30 "$STATE_DIR/$name.log" >&2 || true
      die "$name stopped before it was ready (log: $STATE_DIR/$name.log)"
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      tail -n 30 "$STATE_DIR/$name.log" >&2 || true
      die "$name was not ready after ${READY_TIMEOUT_S}s: $url (log: $STATE_DIR/$name.log)"
    fi
    sleep 0.5
  done
}

stop_all() {
  local force="${1:-}" service
  for service in gateway django; do
    stop_service "$service" "$force"
  done
}

abort_up() {
  echo "stack: up failed; stopping what was started" >&2
  stop_all force
}

stay_in_front() {
  trap 'stop_all; exit 0' TERM INT
  while service_alive gateway && service_alive django; do
    sleep 1 &
    wait "$!" || true
  done
  echo "stack: a service stopped; stopping the other" >&2
  stop_all force
  exit 1
}

cmd_up() {
  local foreground=0 now
  case "${1:-}" in
    "") ;;
    --foreground) foreground=1 ;;
    *) usage ;;
  esac
  if service_alive gateway || service_alive django; then
    die "the stack is already up (scripts/stack.sh status); run down or reset first"
  fi
  port_must_be_free STACK_GATEWAY_PORT "$GATEWAY_PORT"
  port_must_be_free STACK_DJANGO_PORT "$DJANGO_PORT"
  if [ ! -f "$CLIENT_DIR/__spa-fallback.html" ]; then
    die "$CLIENT_DIR is not a frontend production build (no __spa-fallback.html): run pnpm build first"
  fi
  require_tools

  now="${STACK_REPLAY_NOW:-$(current_minute)}"
  ensure_database_server
  ensure_database
  mkdir -p "$STATE_DIR"
  rm -f "$(pid_file django)" "$(pid_file gateway)"
  write_env_file "$now"
  say "replay clock $now, database $DATABASE_NAME"

  say "bootstrapping the roles and migrating (scripts/migrate-database.sh)"
  if ! (
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
    bash "$ROOT/scripts/migrate-database.sh"
  ) >"$STATE_DIR/migrate.log" 2>&1; then
    tail -n 30 "$STATE_DIR/migrate.log" >&2
    die "the bootstrap or the migrations failed (log: $STATE_DIR/migrate.log)"
  fi

  trap abort_up EXIT
  say "starting Django on waitress, port $DJANGO_PORT"
  start_django
  wait_ready django "http://$HOST:$DJANGO_PORT/api/v1/health/ready"
  say "starting the gateway, port $GATEWAY_PORT"
  start_gateway
  wait_ready gateway "$(gateway_url)/api/v1/health/ready"
  trap - EXIT

  cat <<EOF
stack: up
  web       $(gateway_url)
  api       $(gateway_url)/api/v1
  django    http://$HOST:$DJANGO_PORT
  database  $DATABASE_NAME
  clock     HAULCAST_REPLAY_NOW=$now
prefilled links (departure one hour after the clock, $LOAD_WEIGHT_LB lb):
EOF
  print_links "$now" pretty
  echo "stack: check it with scripts/stack.sh smoke, stop it with scripts/stack.sh down"
  if [ "$foreground" = 1 ]; then
    stay_in_front
  fi
}

# ---------------------------------------------------------------------- down, status, logs, reset

cmd_down() {
  local name port stopped=0
  for name in gateway django; do
    if [ -f "$(pid_file "$name")" ]; then
      stopped=1
    fi
  done
  stop_all
  if [ "$stopped" = 0 ]; then
    say "nothing to stop"
  fi
  for port in "$GATEWAY_PORT" "$DJANGO_PORT"; do
    if tcp_open "$HOST" "$port"; then
      die "port $port is still in use after the stack was stopped: something else holds it (or an orphan of this stack: find it with netstat -ano)"
    fi
  done
}

service_status() {
  local name="$1" pid port
  pid="$(read_pid "$name")"
  port="$(service_port "$name")"
  if ! is_alive "$pid"; then
    echo "$name: stopped"
    return 1
  fi
  if ! tcp_open "$HOST" "$port"; then
    echo "$name: not answering (pid $pid, port $port)"
    return 1
  fi
  echo "$name: running (pid $pid) http://$HOST:$port"
}

cmd_status() {
  local code=0
  service_status gateway || code=3
  service_status django || code=3
  echo "database: $DATABASE_NAME"
  echo "clock: $(effective_replay_now)"
  exit "$code"
}

cmd_logs() {
  local which="${1:-all}" name shown=0
  case "$which" in
    all | django | gateway) ;;
    *)
      echo "usage: scripts/stack.sh logs [django|gateway]" >&2
      exit 2
      ;;
  esac
  for name in "${SERVICES[@]}"; do
    if [ "$which" != all ] && [ "$which" != "$name" ]; then
      continue
    fi
    if [ ! -f "$STATE_DIR/$name.log" ]; then
      continue
    fi
    if [ "$which" = all ]; then
      echo "==> $name <=="
    fi
    tail -n "$LOG_TAIL_LINES" "$STATE_DIR/$name.log"
    shown=1
  done
  if [ "$shown" = 0 ]; then
    die "no logs under $STATE_DIR: has the stack been started?"
  fi
}

cmd_reset() {
  cmd_down
  if server_reachable; then
    run_psql -c "DROP DATABASE IF EXISTS $DATABASE_NAME WITH (FORCE)" >/dev/null
    say "dropped database $DATABASE_NAME"
  else
    say "the database server is not running: no database to drop"
  fi
  rm -rf "$STATE_DIR"
  say "forgot the generated settings and logs in $STATE_DIR"
}

cmd_env() {
  local now
  now="$(effective_replay_now)"
  echo "HAULCAST_REPLAY_NOW=$now"
  echo "STACK_URL=$(gateway_url)"
  echo "STACK_API_URL=$(gateway_url)/api/v1"
  echo "STACK_DJANGO_URL=http://$HOST:$DJANGO_PORT"
  echo "STACK_DATABASE_NAME=$DATABASE_NAME"
  print_links "$now" env
}

# ---------------------------------------------------------------------------------------- smoke

STATUS=""
BODY=""

fail() {
  echo "smoke: FAIL $*" >&2
  exit 1
}

pass() {
  echo "smoke: ok   $*"
}

# One request through the gateway; leaves the status in STATUS and the body in BODY.
request() {
  local method="$1" target="$2" out
  shift 2
  out="$(curl -sS --max-time 60 -X "$method" -w $'\n%{http_code}' "$@" "$(gateway_url)$target")" ||
    fail "$method $target: no answer from $(gateway_url) (is the stack up? scripts/stack.sh status)"
  STATUS="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

# The body must satisfy a jq filter (jq -e: true).
body_satisfies() {
  jq -e -b "$1" <<<"$BODY" >/dev/null 2>&1
}

must_have_status() {
  local what="$1" wanted="$2"
  if [[ ! "$STATUS" =~ ^($wanted)$ ]]; then
    fail "$what: answered $STATUS, wanted $wanted. Body: ${BODY:0:300}"
  fi
}

cmd_smoke() {
  local now departure_iso client_ip plan_body plan_id json=(-H 'content-type: application/json')
  command -v jq >/dev/null 2>&1 || die "jq is required"
  now="$(effective_replay_now)"
  departure_iso="$(date -u -d "@$(($(date -d "$now" +%s) + DEPARTURE_OFFSET_S))" +%Y-%m-%dT%H:%M:%SZ)"
  # A client of its own for every run: the limits (6 plans a minute, 60 a day) count per client, and
  # the gateway hands this header to Django exactly as it is.
  client_ip="10.$((RANDOM % 256)).$((RANDOM % 256)).$((RANDOM % 254 + 1))"
  plan_body='{"origin":{"lat":40.7608,"lon":-111.891,"label":"Salt Lake City, Utah, United States"},"destination":{"lat":39.7392,"lon":-104.9903,"label":"Denver, Colorado, United States"},"departure_time":"'"$departure_iso"'","load_weight_lb":'"$LOAD_WEIGHT_LB"',"sampling_interval_mi":25,"scenario":"storm-on-fastest"}'

  request GET /
  must_have_status "front page: GET /" 200
  if ! grep -qi '<html\|<!doctype html' <<<"$BODY"; then
    fail "front page: GET / is not an HTML document. Body: ${BODY:0:300}"
  fi
  pass "front page"

  request GET /api/v1/health
  must_have_status "health: GET /api/v1/health" 200
  body_satisfies '.status == "ok"' || fail "health: status is not ok. Body: ${BODY:0:300}"
  pass "health"

  request GET /api/v1/health/ready
  must_have_status "ready: GET /api/v1/health/ready" 200
  body_satisfies '.status == "ok" and .database == "ok"' || fail "ready: the database is not ok. Body: ${BODY:0:300}"
  pass "ready (database ok)"

  request GET "/api/v1/geocode?q=salt%20lake%20city&limit=3"
  must_have_status "geocode: GET /api/v1/geocode" 200
  body_satisfies '.results[0].name == "Salt Lake City"' || fail "geocode: Salt Lake City is not the first candidate. Body: ${BODY:0:300}"
  pass "geocode"

  request GET /api/v1/scenarios
  must_have_status "scenarios: GET /api/v1/scenarios" 200
  body_satisfies '([.[].id] | sort) == ["calm","gulf-downpour","high-wind-corridor","storm-on-fastest"]' ||
    fail "scenarios: expected the 4 scenarios calm, gulf-downpour, high-wind-corridor, storm-on-fastest. Body: ${BODY:0:300}"
  pass "scenarios (4)"

  request POST /api/v1/plans "${json[@]}" -H "x-forwarded-for: $client_ip" --data "$plan_body"
  must_have_status "plan: POST /api/v1/plans" "200|201"
  body_satisfies '(.routes | length) == 3' || fail "plan: expected 3 routes. Body: ${BODY:0:300}"
  body_satisfies '.recommendation.status == "ok"' || fail "plan: the recommendation is not ok. Body: ${BODY:0:300}"
  body_satisfies '(.routes | min_by(.duration_s) | .route_id) != .recommendation.route_id' ||
    fail "plan: storm-on-fastest must recommend a route that is not the fastest one, but the recommendation is the fastest route. Body: ${BODY:0:300}"
  plan_id="$(jq -r -b '.plan_id' <<<"$BODY")"
  pass "plan $plan_id (3 routes, the recommended one is not the fastest)"

  request GET "/api/v1/plans/$plan_id/heatmap" -H "x-forwarded-for: $client_ip"
  must_have_status "heatmap: GET /api/v1/plans/$plan_id/heatmap" 200
  body_satisfies '.frame_count == 49' || fail "heatmap: expected 49 frames. Body: ${BODY:0:300}"
  pass "heatmap (49 frames)"

  request POST /api/v1/plans "${json[@]}" -H "x-forwarded-for: $client_ip" -H "Origin: $(gateway_url)" --data "$plan_body"
  must_have_status "Origin: POST /api/v1/plans with the origin of the gateway" "200|201"
  pass "a POST from the origin of the gateway is accepted"

  # The limiter counts a client by x-forwarded-for, which the gateway hands to Django as it came.
  # One client is limited after a burst (its bucket holds 6 plans a minute); another one is not.
  # The e2e projects give every test a client of its own on the strength of this.
  burst_ip="10.$((RANDOM % 256)).$((RANDOM % 256)).$((RANDOM % 254 + 1))"
  other_ip="11.$((RANDOM % 256)).$((RANDOM % 256)).$((RANDOM % 254 + 1))"
  for _ in $(seq 1 "$BURST_REQUESTS"); do
    request POST /api/v1/plans "${json[@]}" -H "x-forwarded-for: $burst_ip" --data "$plan_body"
    if [ "$STATUS" = 429 ]; then
      break
    fi
  done
  if [ "$STATUS" != 429 ]; then
    fail "clients: $BURST_REQUESTS plan requests from one client were never limited (last answer $STATUS): is the rate limiter counting?"
  fi
  request POST /api/v1/plans "${json[@]}" -H "x-forwarded-for: $other_ip" --data "$plan_body"
  must_have_status "clients: a second client right after the first was limited (x-forwarded-for does not reach Django as sent)" "200|201"
  pass "clients are told apart by x-forwarded-for (one limited, another not)"

  echo "smoke: all checks passed"
}

# ----------------------------------------------------------------------------------------- main

main() {
  local command="${1:-}"
  case "$command" in
    up | down | status | reset | env | logs | smoke) ;;
    *) usage ;;
  esac
  shift
  validate_settings
  case "$command" in
    up) cmd_up "$@" ;;
    down) cmd_down ;;
    status) cmd_status ;;
    reset) cmd_reset ;;
    env) cmd_env ;;
    logs) cmd_logs "$@" ;;
    smoke) cmd_smoke ;;
  esac
}

main "$@"
