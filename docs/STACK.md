# The local stack

One command starts a stack that behaves like the deployed app and never touches a third party:
Postgres, the migrated schema, Django on [waitress](https://docs.pylonsproject.org/projects/waitress/),
and the production build of the frontend behind a small gateway that proxies `/api` to Django, the
way Vercel serves this repository. The backend runs in **replay mode**: the routing, weather and
geocoding providers are answered from the recorded fixtures in `backend/tests/fixtures/providers`,
over the real adapters, with the wall clock frozen (see [BACKEND.md](BACKEND.md), "Replay mode").

It exists for the end-to-end projects that run against a real API, the Tier 1 performance run, the
security review, the manual UAT and the screen recordings. The e2e projects that use mock data
(`frontend/e2e/support/mock-api.ts`) do not need it.

```text
browser ── http://127.0.0.1:4210 ──► gateway (Node) ── /api/* ──► Django on waitress (127.0.0.1:8110) ──► Postgres
                                       │                                   │
                                       └─ frontend/build/client            └─ replay adapters: recorded fixtures, frozen clock
                                          (the preview module, SPA fallback)
```

## Quick start

```bash
pnpm --dir frontend install --frozen-lockfile   # once
pnpm build                                      # the gateway serves the production build
bash scripts/stack.sh up                        # database, roles, migrations, Django, gateway
bash scripts/stack.sh smoke                     # curl + jq against the gateway
bash scripts/stack.sh down                      # stop what `up` started
```

`pnpm run stack up` is the same as `bash scripts/stack.sh up` (root `package.json`).

`up` prints the URLs and one prefilled planner link for each recorded trip. Open one of them in a
browser, press the plan button, and the planner shows a real plan made by the real backend.

## Commands

| Command                    | What it does                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `up`                       | Start the database server if needed, create the stack database, write the generated settings, bootstrap the roles and migrate, start Django and the gateway, wait until `GET /api/v1/health/ready` answers 200 through the gateway, print the URLs and the links. Exit 0 when it is ready. Refuses a busy port and a missing build; if anything fails it stops what it started. |
| `up --foreground`          | The same, then stay in front. SIGTERM or Ctrl-C stops both services; if one of them dies the other is stopped and the exit code is 1. This is the form for a Playwright `webServer`. |
| `down`                     | Stop the gateway and Django, by the pids that `up` wrote under `.local/stack/`. Never the database server, never by process name. Exit 1 if a port is still in use afterwards. |
| `status`                   | One line for each service (pid and URL), the database name and the clock. Exit 0 when both services answer, 3 when they do not.                       |
| `reset`                    | `down`, then drop the stack database (the roles stay) and delete `.local/stack/` (the generated secrets, the pid files and the logs).                 |
| `env`                      | Print `HAULCAST_REPLAY_NOW`, the URLs and one prefilled link per trip, one `NAME=value` per line, for test fixtures. Starts nothing.                  |
| `logs [django\|gateway]`   | The last 100 lines of the log of one service, or of both.                                                                                            |
| `smoke`                    | Nine checks through the gateway, with `curl` and `jq` only (below). Safe to repeat: every run is a client of its own.                                |

### What the smoke checks

1. `GET /` answers 200 with an HTML document (the gateway serves the build).
2. `GET /api/v1/health` answers 200 with `status: ok`.
3. `GET /api/v1/health/ready` answers 200 with `database: ok`.
4. `GET /api/v1/geocode?q=salt lake city` lists Salt Lake City first.
5. `GET /api/v1/scenarios` lists the four scenarios.
6. `POST /api/v1/plans`, Salt Lake City to Denver with scenario `storm-on-fastest`, departing one
   hour after the clock: 201 (200 with the stored plan on a repeat), three routes, and the
   recommended route is **not** the fastest.
7. `GET /api/v1/plans/{id}/heatmap` answers 200 with 49 frames.
8. A POST that carries `Origin: <the gateway>` is accepted (never 403).
9. The rate limiter tells clients apart by `x-forwarded-for`: one client is limited after a burst
   of plan requests, another one is not.

## Ports and database names

The defaults are those of card T10. A card that runs on the same machine at the same time sets
`STACK_GATEWAY_PORT` and `STACK_DJANGO_PORT` to its own pair (T11 to T17 use 4211 to 4217 and 8111
to 8117) and its own `STACK_DATABASE_NAME`, so two stacks do not meet.

| Item     | Variable             | Default | Who else uses what                                                                |
| -------- | -------------------- | ------- | --------------------------------------------------------------------------------- |
| Gateway  | `STACK_GATEWAY_PORT` | 4210    | the browser, the e2e `baseURL`; cards T11 to T17 use 4211 to 4217                 |
| Django   | `STACK_DJANGO_PORT`  | 8110    | behind the gateway only; cards T11 to T17 use 8111 to 8117                        |
| Database | `STACK_DATABASE_NAME`| `haulcast_stack` | CI uses the default; card ST used `haulcast_stack_st`, card Z uses `haulcast_stack_z` |

The ports are exact: if one is taken, `up` stops with an error naming it. The stack never moves to
another port, and `down` never stops a process that it did not start.

## Variables

All of them are optional.

| Variable              | Default                                | Meaning                                                                                                                                                                   |
| --------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STACK_GATEWAY_PORT`  | `4210`                                 | Port of the gateway.                                                                                                                                                      |
| `STACK_DJANGO_PORT`   | `8110`                                 | Port of Django.                                                                                                                                                           |
| `STACK_DATABASE_NAME` | `haulcast_stack`                       | Database of the stack (lower-case letters, digits, underscores).                                                                                                          |
| `STACK_DATABASE_URL`  | the portable Postgres of `scripts/dev-db.sh` | Administrator DSN of the server to use, for example `postgresql://postgres@localhost:5432/postgres` (the CI service container). Its database is ignored. When it is unset and the server is down, `up` starts it with `scripts/dev-db.sh`. |
| `STACK_REPLAY_NOW`    | the current UTC minute, read at `up`   | The instant the backend believes it is: ISO 8601 **with an offset**, for example `2026-10-24T05:30:00Z`. Set it for runs that must be reproducible (goldens, e2e).         |
| `STACK_STATE_DIR`     | `.local/stack`                         | Pid files, logs and the generated settings.                                                                                                                               |
| `STACK_CLIENT_DIR`    | `frontend/build/client`                | The production build to serve.                                                                                                                                            |

`up` writes `.local/stack/env` (gitignored, mode 600 where the system has modes) with the settings
that Django needs. The secrets in it are generated and throw-away (`DJANGO_SECRET_KEY` of 64
characters, `RATE_LIMIT_SALT`, the passwords of the two database roles); they are kept between runs,
because the roles live in the server and keep their passwords, and `reset` forgets them. Nothing in
the file is ever printed. These are the settings, by name:

```text
DATABASE_URL, DATABASE_URL_POOLED, DJANGO_SECRET_KEY, RATE_LIMIT_SALT, HAULCAST_APP_DB_PASSWORD,
HAULCAST_OWNER_DB_PASSWORD, ALLOWED_HOSTS=127.0.0.1,localhost, ALLOWED_ORIGINS=<the gateway origin>,
CLIENT_IP_HEADER=x-forwarded-for, HAULCAST_PROVIDER_MODE=replay, HAULCAST_REPLAY_NOW=<the clock>
```

`HAULCAST_REPLAY_DIR` is not set: the default catalog (`backend/tests/fixtures/providers`) is the
one to use. `VERCEL_ENV` and `HAULCAST_ENV=production` are never set, because replay refuses them.

The runtime process gets `DATABASE_URL_POOLED` (coordinates only: the runtime connects as
`haulcast_app` with its own password) and not the administrator DSN or the owner password. Those
two stay with the migration step, as in production.

### The clock

The backend accepts a departure only inside `[HAULCAST_REPLAY_NOW - 15 min, HAULCAST_REPLAY_NOW +
120 h]`, and the frozen clock never moves on. So the clock has no default date: `up` takes the current
minute, or exactly `STACK_REPLAY_NOW`. `bash scripts/stack.sh env` prints the clock of the running
stack (or the one `up` would choose now). Every prefilled link departs one hour after the clock.
A browser test that needs the same "now" starts its own clock at that instant (Playwright
`page.clock.install({ time })`, with time flowing), and builds departures from it.

Two consequences of a frozen server clock: a stored plan never expires, and the 10-minute
idempotency window never closes, so an identical request returns the stored plan (200, not 201). Specs
must not depend on 201. Only wall clocks are frozen: the rate limiter refills with real time.

## The replay catalog

Four trips are recorded. Any other pair of places answers `422 no_route_found`, which is how a test
reaches that error from a real backend. A position within 1.25 miles of a recorded endpoint counts
as that endpoint. Every row below: `POST /api/v1/plans` gives 201 (200 on a repeat) and the heatmap
has 49 frames. Source: `backend/tests/api/test_replay_mode.py`; `bash scripts/dev-db.sh run uv run
--directory backend pytest tests/api/test_replay_mode.py -s` prints the table.

| trip      | scenario           | load lb | status        | routes | recommended | decided by   | no travel mi | routes crossing |
| --------- | ------------------ | ------: | ------------- | -----: | ----------- | ------------ | -----------: | --------------: |
| slc-den   | none               |  38,000 | ok            |      3 | A           | duration_s   |            0 |               0 |
| slc-den   | calm               |  38,000 | ok            |      3 | A           | duration_s   |            0 |               0 |
| slc-den   | storm-on-fastest   |  38,000 | ok            |      3 | C           | duration_s   |            0 |               0 |
| slc-den   | high-wind-corridor |  38,000 | ok            |      3 | C           | duration_s   |            0 |               1 |
| slc-den   | gulf-downpour      |  38,000 | ok            |      3 | C           | duration_s   |            0 |               0 |
| chi-den   | none               |  38,000 | ok            |      2 | A           | duration_s   |            0 |               0 |
| chi-den   | calm               |  38,000 | ok            |      2 | A           | duration_s   |            0 |               0 |
| chi-den   | storm-on-fastest   |  38,000 | ok            |      2 | B           | severe_mi    |            0 |               0 |
| chi-den   | high-wind-corridor |  38,000 | ok            |      2 | B           | no_travel_mi |            0 |               1 |
| chi-den   | gulf-downpour      |  38,000 | ok            |      2 | B           | severe_mi    |            0 |               0 |
| newark-jc | none               |  38,000 | ok            |      3 | A           | duration_s   |            0 |               0 |
| newark-jc | calm               |  38,000 | ok            |      3 | A           | duration_s   |            0 |               0 |
| newark-jc | storm-on-fastest   |  38,000 | ok            |      3 | A           | duration_s   |            0 |               0 |
| newark-jc | high-wind-corridor |  38,000 | no_safe_route |      3 | A           | duration_s   |          8.9 |               3 |
| newark-jc | gulf-downpour      |  38,000 | ok            |      3 | A           | duration_s   |            0 |               0 |
| la-phx    | none               |  38,000 | ok            |      1 | A           | only_route   |            0 |               0 |
| la-phx    | calm               |  38,000 | ok            |      1 | A           | only_route   |            0 |               0 |
| la-phx    | storm-on-fastest   |  38,000 | ok            |      1 | A           | only_route   |            0 |               0 |
| la-phx    | high-wind-corridor |  38,000 | no_safe_route |      1 | A           | only_route   |          100 |               1 |
| la-phx    | gulf-downpour      |  38,000 | ok            |      1 | A           | only_route   |            0 |               0 |
| slc-den   | high-wind-corridor |  25,000 | ok            |      3 | C           | duration_s   |            0 |               0 |
| chi-den   | high-wind-corridor |  25,000 | ok            |      2 | B           | severe_mi    |            0 |               0 |
| newark-jc | high-wind-corridor |  25,000 | ok            |      3 | A           | duration_s   |            0 |               0 |
| la-phx    | high-wind-corridor |  25,000 | ok            |      1 | A           | only_route   |            0 |               0 |

`high-wind-corridor` at 38,000 lb is `no_safe_route` on `newark-jc` and `la-phx` only; on `slc-den`
and `chi-den` one route crosses the band and the recommended one avoids it. The four scenario ids
are `calm`, `storm-on-fastest`, `high-wind-corridor` and `gulf-downpour`.

The coordinates the replay routes exactly:

| trip      | origin (label, lat, lon)                                        | destination (label, lat, lon)                                      | link shows         |
| --------- | --------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------ |
| slc-den   | Salt Lake City, Utah, United States (40.7608, -111.891)         | Denver, Colorado, United States (39.7392, -104.9903)               | storm-on-fastest   |
| chi-den   | Chicago, Illinois, United States (41.8781, -87.6298)            | Denver, Colorado, United States (39.7392, -104.9903)               | storm-on-fastest   |
| newark-jc | Newark, New Jersey, United States (40.7357, -74.1724)           | Jersey City, New Jersey, United States (40.7178, -74.0431)         | high-wind-corridor |
| la-phx    | Los Angeles, California, United States (34.0522, -118.2437)     | Phoenix, Arizona, United States (33.4484, -112.074)                | calm               |

The geocoder answers a recorded query from its recording and any other query of two or more
characters from the seven cities above, by case-insensitive prefix (`sal`, `den`, `chi`, `new`,
`jer`, `los`, `pho`).

### Prefilled links

The planner reads `origin`, `destination`, `depart`, `load` and `scenario` from the address (R9).
`up` and `env` print one link per trip. For the clock `2026-10-24T05:30:00Z` the link of `slc-den` is:

```text
http://127.0.0.1:4210/?origin=Salt%20Lake%20City,%20Utah,%20United%20States@40.7608,-111.891&destination=Denver,%20Colorado,%20United%20States@39.7392,-104.9903&depart=2026-10-24T06:30Z&load=38000&scenario=storm-on-fastest
```

`env` prints them as `STACK_LINK_SLC_DEN`, `STACK_LINK_CHI_DEN`, `STACK_LINK_NEWARK_JC` and
`STACK_LINK_LA_PHX`. Every `depart` is one hour after `HAULCAST_REPLAY_NOW`, inside the window the
API accepts.

## How the gateway behaves

`scripts/stack/gateway.mjs` is `pnpm preview` plus a proxy: it takes the static files and the SPA
fallback from `frontend/scripts/preview/server.ts` (imported, not copied) and sends `/api` and
`/api/...` to Django. Nothing else is proxied: a path such as `/apix` or `/x/api/v1/health` is the
static server's business.

- `Host` goes through unchanged. Django compares the `Origin` of a POST with the host of the request
  and validates `ALLOWED_HOSTS` against it; a rewritten host answers 400 or 403.
- `x-forwarded-for` goes through exactly as the client sent it, and the gateway never adds one. The
  backend counts a client by that header (`CLIENT_IP_HEADER`) and only when it holds exactly one IP, so
  a hop appended by the proxy would put every client into the shared `unknown` bucket. A request
  without the header shares that bucket (6 plans a minute for everybody): a browser session is one
  client, a test gives each test its own unique IPv4 in the header.
- Django runs with `--no-clear-untrusted-proxy-headers`. waitress 3 deletes `x-forwarded-for` from
  every request unless the peer is a configured trusted proxy, and without this option every client
  of the stack shared one rate-limit bucket (found by the first smoke that sent two clients).
- A Django that is not listening gives `502` with a problem document, never a canned answer.

The gateway listens on `E2E_PORT` like `pnpm preview` does (`stack.sh` sets it from
`STACK_GATEWAY_PORT`) and needs `STACK_DJANGO_PORT`; a busy port is an error, never another port.

## How CI and the e2e use it

- **`.github/workflows/stack.yml`** runs `pnpm build`, `bash scripts/stack.sh up`, `smoke` (twice)
  and `down` on a clean runner with a Postgres 17 service container (`STACK_DATABASE_URL`), and
  uploads `.local/stack/*.log` when it fails. It runs when `backend/`, the risk rules and scenarios
  in `shared/`, `scripts/stack.sh`, `scripts/stack/`, `scripts/tests/stack.test.mjs`,
  `scripts/migrate-database.sh`, this file or the workflow change. It does not run for a change that
  touches only `frontend/`.
- **`pnpm run test:scripts`** covers the gateway and the commands of `stack.sh` that need neither
  Postgres nor Django (`scripts/tests/stack.test.mjs`), at 100% line, branch and function coverage.
- **The e2e projects** that run against the real API can start the stack with
  `STACK_REPLAY_NOW=<a fixed instant> bash scripts/stack.sh up --foreground` (a Playwright
  `webServer`), read the clock and the URLs from `bash scripts/stack.sh env`, send a unique
  `x-forwarded-for` with every test (every client has its own rate-limit bucket), and install the
  browser clock at the same instant.
- **R7 Tier 1** (the hardware-GPU run on the integrated page) and the manual UAT use the stack on
  the default ports.

## Resetting

```bash
bash scripts/stack.sh reset
```

stops the stack, drops the stack database and deletes `.local/stack/`. The database roles
`haulcast_owner` and `haulcast_app` belong to the server, not to one database, so `reset` leaves
them and the next `up` sets their passwords again (bootstrap is idempotent). Stacks that share a
server also share the two roles, and each `up` writes the passwords of its own settings file: do not
run two stacks with different settings against one server at the same time.

## Windows notes (git-bash)

- Run everything in git-bash. Native programs get `C:/`-style paths (the scripts convert them).
- `curl` and `jq` are native Windows programs there: `curl -o /dev/null` fails (`/dev/null` is not a
  Windows path), so the scripts redirect with the shell instead; `jq` needs `-b` or it ends lines with
  CRLF. Install `jq` with `winget install jqlang.jq` (or put `jq.exe` from
  <https://github.com/jqlang/jq/releases> into a folder on the `PATH`).
- `psql` is taken from the `PATH`, else from `$PG_HOME/bin` (`C:/Tools/pgsql-17` by default, as in
  `scripts/dev-db.sh`).
- In a git worktree, point the portable Postgres at the shared data directory before the first
  `up`: `export DEV_DB_DATA_DIR=C:/Projects/weather-aware-truck-routing/.local/pg`. When a server
  already answers on the port, `up` uses it and starts nothing.
- `down` stops a service with `kill <pid>`; `uv` and the Python it starts end together. It never
  uses `taskkill` or `pkill`. After `down`, `netstat -ano | grep -E ":(4210|8110) "` shows no
  `LISTENING` line.
- On a loaded machine the first request after `up` can fail with `connection timeout expired`: the
  runtime role gives a database connection 3 seconds. Repeat it.

## Why replay is refused in a deployed environment

Replay answers from recordings and freezes the clock. On a deployment that would show real users
canned weather and refuse every departure after five days. So the backend refuses to start in replay
mode when `VERCEL_ENV` is `production` or `preview`, or `HAULCAST_ENV` is `production`, and the error
names `HAULCAST_PROVIDER_MODE`. The catalog also lives under `backend/tests/`, which `vercel.json`
leaves out of the function. The stack sets none of these variables.
