# Haulcast — Weather-Aware Truck Routing

Haulcast helps a truck driver pick the safest of three route options from ETA-timed weather
checkpoints, load-aware risk scoring and a 0–48 h corridor forecast heatmap.
Built with React, Django and Supabase Postgres, deployed on Vercel.

> Work in progress on `feat/weather-aware-routing`.

## Repository layout

| Path        | Purpose                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| `backend/`  | Django 5.2 + Django Ninja API (`uv` project, Python 3.12)                    |
| `frontend/` | React 19 + React Router 7 (framework mode, prerendered SPA), `pnpm`          |
| `shared/`   | Cross-stack JSON contracts, e.g. `risk-rules.json` read by both stacks       |
| `api/`      | Vercel Python entrypoint only (`api/index.py` serves Django as one function) |
| `scripts/`  | Developer tooling (`dev-db.sh` local Postgres, `dev.sh` full stack)          |

## Local development

Prerequisites: [uv](https://docs.astral.sh/uv/), Node 24.21.0 with [pnpm](https://pnpm.io/) 12,
and a bash shell (Git Bash on Windows). Node 24.21.0 is the release in `frontend/.nvmrc`; `engines`
repeats it, and the bundle-size check can judge exact equality only on that release.

```bash
pnpm --dir frontend install      # frontend dependencies
uv sync --directory backend      # backend dependencies (installs Python 3.12 if needed)
```

### Local Postgres (no Docker)

The backend test-suite runs against a **real PostgreSQL of the same major version as Supabase**
(17), never SQLite. On Windows the portable EDB binaries need no admin rights:

1. Download `postgresql-17.11-1-windows-x64-binaries.zip` from the
   [EDB binaries page](https://www.enterprisedb.com/download-postgresql-binaries).
2. Unpack its `pgsql/` folder to `C:/Tools/pgsql-17/` (outside the repo). On another platform
   point `PG_HOME` at any PostgreSQL 17 install prefix instead.

`scripts/dev-db.sh` then manages the server (idempotent; data in the gitignored `.local/pg`,
`127.0.0.1:54329`, trust auth, durability off because the data is disposable):

```bash
bash scripts/dev-db.sh start      # init if needed, start, create the `haulcast` database
bash scripts/dev-db.sh status     # exit 0 = running, 3 = stopped
bash scripts/dev-db.sh url        # prints TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/haulcast
bash scripts/dev-db.sh stop
bash scripts/dev-db.sh run CMD    # start if needed, then run CMD with TEST_DATABASE_URL exported
```

### Quality gates

```bash
# Backend (from backend/)
uv run ruff check . && uv run ruff format --check . && uv run mypy --strict src
bash ../scripts/dev-db.sh run uv run pytest --cov --cov-branch --cov-fail-under=100

# Frontend (from frontend/)
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build
```

The root `package.json` wraps both: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`
and `pnpm dev` (starts Postgres, the Django API on :8000 and Vite on :5173).

### Configuration

Every environment variable is listed, with a comment and no value, in
[`.env.example`](.env.example). Copy it to `.env.local` (gitignored) for local secrets.
The test-suite reads only `TEST_DATABASE_URL`, so it can never touch a real deployment's database.
