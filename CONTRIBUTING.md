# Contributing

Haulcast is a monorepo: `backend/` (Django 5.2 + Django Ninja, `uv`), `frontend/` (React 19 +
React Router 7, `pnpm`), `shared/` (cross-stack JSON contracts), `api/` (the Vercel Python entry
point) and `scripts/` (tooling). The pipelines are described in [docs/CI-CD.md](docs/CI-CD.md).

## Setup

Prerequisites: [uv](https://docs.astral.sh/uv/), Node 22.12+ with pnpm 12, a bash shell (Git Bash on
Windows) and a PostgreSQL 17 for the backend tests (see "Local Postgres" in the README).

```bash
uv sync --directory backend --locked
pnpm --dir frontend install --frozen-lockfile
pre-commit install --install-hooks     # pre-commit + commit-msg hooks (optional but recommended)
```

## The gates (all must be green before a pull request)

```bash
pnpm run check                 # lint + typecheck + tests (100 % coverage) + build, both stacks
pnpm run openapi:check         # shared/openapi.json and the generated types match the backend
pnpm run vercel:check          # vercel.json against the official schema and project invariants
pnpm run vercel:build          # no-account `vercel build` dry run + CSP and bundle verification
pnpm run test:scripts          # tests of the tooling in scripts/
pnpm --dir frontend e2e        # Playwright (chromium, firefox, webkit, Pixel 7, iPhone 14)
```

CI runs the same commands (`.github/workflows/ci.yml`). Coverage is 100 % line and branch on both
stacks; there are no `# type: ignore`, `@ts-ignore`, `eslint-disable` or skipped tests, and no
coverage pragmas without a one-line justification a reviewer accepted.

## When you change ...

- the API: `pnpm run openapi:export`, commit `shared/openapi.json`, regenerate the frontend types
  (`pnpm dlx openapi-typescript@7.13.0 shared/openapi.json -o frontend/app/api/schema.d.ts`).
- backend dependencies: `uv lock`, then `pnpm run requirements:export` and commit
  `api/requirements.txt` (the Vercel function installs from it; CI compares it with `uv.lock`).
- `vercel.json`: keep `script-src 'self'` as is. The hashes of the prerendered pages' inline scripts
  are added at build time (`scripts/vercel_output.py`), so no hash is ever committed.

## Commits and branches

- [Conventional Commits 1.0](https://www.conventionalcommits.org/): `feat(backend): ...`,
  `fix(frontend): ...`, `ci: ...`, `docs: ...`. Subject at most 72 characters, imperative, no
  trailing period, lower-case first word; body wrapped at 100 explaining *why*. One logical change
  per commit. `commitlint.config.mjs` enforces this on commit messages (pre-commit hook) and on
  pull-request titles (CI).
- `main` only receives the final integration pull request, and only the maintainer merges it.
  Work happens on `feat/weather-aware-routing`; each task has its own branch (and git worktree)
  off it, a pull request into it, and is merged with **rebase-merge** after CI is green.
- Before merging into the integration branch, request a CodeRabbit review (`@coderabbitai review`)
  and handle every thread and summary comment: fix what is valid (with tests), answer what is not,
  resolve all threads.

## Security

Never commit secrets or `.env*` files (only `.env.example`). Report vulnerabilities privately, see
[SECURITY.md](SECURITY.md).
