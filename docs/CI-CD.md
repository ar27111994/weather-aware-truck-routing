# CI/CD

Five workflows, one deploy path. Every action is pinned to a full commit SHA (Dependabot keeps them
current), every job declares its own least-privilege `permissions:` and a `timeout-minutes`.

## Workflow graph

```mermaid
flowchart LR
  PR[pull request] --> CI
  PUSH[push to integration branch or main] --> CI
  subgraph CI[ci.yml]
    T[PR title] --> G
    B[Backend] --> G
    F[Frontend] --> G
    O[OpenAPI drift] --> G
    E[E2E x5 projects] --> G
    V[Vercel config and build dry run] --> G
    G[CI gate]
    LHL[Lighthouse: local build<br/>PRs into the integration branch, pushes]
  end
  G -->|pull request| DP[deploy.yml: preview]
  G -->|push to main| DM[deploy.yml: production]
  DP -->|preview URL, PRs into main| LHP[Lighthouse: the preview]
  PR --> SEC[security.yml]
  WEEK[weekly schedule] --> SEC
  MAIN[push to main] --> REL[release.yml: release-please]
```

| Workflow         | Runs on                                    | What it enforces                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`         | PR, push (integration branch, main), manual | PR title, backend (ruff, format, mypy strict, pytest 100 % branch on `postgres:17`), frontend (eslint, prettier, tsc, vitest 100 %, build), OpenAPI drift, E2E per Playwright project, `vercel.json` + build dry run |
| `security.yml`   | PR, push, weekly, manual                   | CodeQL (python, javascript-typescript), gitleaks on the full history, dependency review (PR), pip-audit + pnpm audit (high), bandit, OSV-Scanner                                                                 |
| `lighthouse.yml` | called by `ci.yml` (PRs, pushes); manual | `lighthouserc.json` budgets (mobile performance >= 90, accessibility / best practices / SEO = 100, LCP < 2.5 s, CLS < 0.05, TBT < 200 ms on `/` and `/methodology`): **blocking** on `main`, **published but not blocking** on the integration branch until `LIGHTHOUSE_ENFORCE` is switched on, see [Lighthouse](#lighthouse-staged-gate-and-measurement-fidelity) |
| `deploy.yml`     | called by `ci.yml` after the gate; manual  | `vercel pull` > `vercel build` > migrations (production) > `vercel deploy --prebuilt` > smoke > promote (production)                                                                                              |
| `release.yml`    | push to `main`, manual                     | release-please: Conventional Commits > release PR (CHANGELOG, versions) > tag + GitHub Release                                                                                                                    |

Deployments are gated with `needs: [gate]` inside `ci.yml` (not `workflow_run`), so they run on the
very commit CI tested, work from the integration branch, and never run for fork pull requests.
`workflow_dispatch` on `deploy.yml` (input `environment`: preview or production) is offered by GitHub
once the file exists on the default branch.

## Required secrets

Set under Settings > Secrets and variables > Actions. The pipeline never sets them.

| Secret                            | Used by                          | Notes                                                                                                                   |
| --------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `VERCEL_TOKEN`                    | deploy                           | A Vercel access token of the account that owns the project                                                              |
| `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | deploy                        | From `.vercel/project.json` after `vercel link`                                                                         |
| `DATABASE_URL_OWNER`              | deploy (production bootstrap and migrations) | Administrator DSN (the Supabase `postgres` user) through the **session** pooler (port 5432, `sslmode=require`)          |
| `HAULCAST_OWNER_DB_PASSWORD`      | deploy (production bootstrap and migrations) | Password of the schema-owner role `haulcast_owner` (DDL): the bootstrap creates the role with it, the migrations run as it |
| `HAULCAST_APP_DB_PASSWORD`        | deploy (production bootstrap)    | Password of the least-privilege runtime role `haulcast_app`                                                             |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | deploy smoke tests, Lighthouse  | Vercel Protection Bypass for Automation; previews stay protected, requests send `x-vercel-protection-bypass` (Lighthouse exchanges it for a cookie) |
| `RELEASE_PLEASE_TOKEN` (optional) | release                          | A PAT or app token. Without it release-please uses `GITHUB_TOKEN` and its release PR gets no CI run (GitHub limitation) |

Without the Vercel secrets a **preview** deployment is skipped with a visible warning annotation; a
**production** deployment fails loudly.

## Repository variables

Set under Settings > Secrets and variables > Actions > **Variables**. Not secrets, so they appear in
logs.

| Variable             | Used by          | Notes                                                                                                                                                                              |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIGHTHOUSE_ENFORCE` | `lighthouse.yml` | `true` makes a missed Lighthouse budget fail the job on every branch; unset or `false` keeps the staging below (published, not blocking, off `main`). Any other value fails the job. |

Flip it with `gh variable set LIGHTHOUSE_ENFORCE --body true` once the real pages meet the budgets.

## Lighthouse: staged gate and measurement fidelity

`lighthouserc.json` holds the budgets (the N1 requirements). `scripts/lighthouse_report.py` reads the
same file, evaluates them on the run `lhci` itself would assert on (`median-run`: closest to the median
first-contentful-paint and interactive time) and decides what a miss means:

| Event                                                            | Mode        | A missed budget                                                                  |
| ---------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| pull request into `main`, push to `main`                         | **enforce** | fails the job (`Lighthouse / Lighthouse budgets` is a required check on `main`)  |
| pull request into the integration branch, push to it, manual run | **report**  | published as a warning annotation, the job summary and one sticky PR comment     |
| any of the above with `LIGHTHOUSE_ENFORCE=true`                  | **enforce** | fails the job                                                                    |

The staging exists because the placeholder pages cannot meet the budgets yet; the integration card
that lands the real pages flips `LIGHTHOUSE_ENFORCE`. The sticky comment (marker
`<!-- lighthouse-report -->`, owned by `github-actions[bot]`, updated in place) is skipped for fork
pull requests, whose token is read-only; the full reports are the `lighthouse-reports` artifact.

**What is measured.** A gate that measures a different server than production is not a gate, so:

- By default the job builds the site exactly as a deployment is built (`scripts/vercel-build.sh
dry-run`, the same step the `vercel` CI job runs) and serves `.vercel/output` with
  `scripts/serve-vercel-output.mjs`. It evaluates the build's `config.json` routes on every request
  (all `vercel.json` headers including the CSP with the hashed inline scripts, the immutable cache for
  `/assets/*`, the SPA fallback, 404 pages) and answers text with brotli or gzip like Vercel's edge
  does. Load-time effects of the old compression-less preview server are gone.
- It is a local approximation and says so: HTTP/1.1 on loopback (no HTTP/2, no CDN latency), compression
  levels are assumptions, and `/api/*` answers `501` (the Python function is not served), so a page that
  calls the API on load needs the preview measurement. The server refuses `config.json` route features
  it does not implement instead of serving something different.
- For pull requests into `main`, once `deploy.yml` produces a preview, that **deployment** is
  measured instead (`lighthouse-preview` in `ci.yml`). A protected preview answers 401, so
  `scripts/lighthouse-bypass.cjs` sends `VERCEL_AUTOMATION_BYPASS_SECRET` once, in a tab the
  measurement does not use, and keeps the bypass **cookie**. Lighthouse's `extraHeaders` would send the
  secret to every request, third parties included, and write it into the saved reports; the job also
  scans the reports for the secret before uploading them. Run it by hand against any deployment with
  `gh workflow run lighthouse.yml -f url=https://<deployment>` (needs the workflow on the default branch).
- Chrome always runs headless: `lighthouserc.json` asks for `--headless=new` and the puppeteer launch is headless, so a
  local run never opens a window. Only the CI step adds `--no-sandbox` (the runner's AppArmor profile needs it).

## What `vercel.json` does (JSON has no comments)

- `framework: null`, `buildCommand`/`installCommand` for the prerendered React Router build and
  `outputDirectory: frontend/build/client`; `git.deploymentEnabled: false` (GitHub Actions deploys).
- One Python function, `api/index.py` (region `iad1`, `maxDuration` 30 s: the plan request budget is
  25 s). `excludeFiles` keeps `frontend/`, `node_modules/`, tests and tooling out of the bundle;
  dependencies come from `api/requirements.txt` (`uv export` of `backend/uv.lock`, drift-checked).
- Rewrites: `/api/(.*)` to the function, then a SPA fallback to `/__spa-fallback.html` for paths
  without a dot outside `/api/` and `/assets/`. Vercel serves existing files (prerendered pages,
  assets) before rewrites, and a missing hashed asset is a 404, not HTML.
- Headers: HSTS (`max-age` 2 years, `includeSubDomains`, `preload`), `nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, COOP/CORP `same-origin`, `X-Frame-Options`, immutable cache for
  `/assets/*`, revalidating cache for everything else, and the CSP below for non-API paths.
- Cron: `GET /api/v1/internal/maintenance` once a day (Hobby limit); Vercel Cron only issues GET, so
  the endpoint accepts GET (Bearer `CRON_SECRET`) and POST for manual runs.

### Content-Security-Policy and the inline scripts

React Router's prerendered HTML contains inline scripts (hydration context, route-module imports with
content-hashed asset names, React's streaming runtime). A strict `script-src 'self'` blocks them and
the page never hydrates, yet their hashes change with every build, so a committed hash would rot.
`scripts/vercel_output.py inject-csp` therefore runs after `vercel build`: it hashes every executable
inline script in the built HTML and appends the hashes to `script-src` in `.vercel/output/config.json`.
`verify` then proves that every inline script is allowed, that no `'unsafe-inline'`, `'unsafe-eval'` or
`'strict-dynamic'` is present, that the Python bundle contains no frontend or test files and that the
static tree and cron registration are complete. CI runs the identical sequence without a Vercel
account (`scripts/vercel-build.sh dry-run`); the deployed `@smoke` Playwright test asserts a clean
console, which is where a CSP violation would show. The no-flash theme script, once added, is covered
automatically.

## Setting up the Vercel project (what the first real deployment taught)

Verified facts from the tracer deployment, in the order they bite:

- **Create the project through the API, not `vercel link`.** For a new project `vercel link` scans
  the monorepo, detects `services` (frontend React Router, backend Django) and then refuses our
  `vercel.json`: top-level `functions`, `buildCommand`, `installCommand` and `outputDirectory`
  cannot coexist with `services`. Create the project with framework `null` (Other) and Node 22.x
  (`POST /v11/projects`, then `PATCH /v9/projects/<id>`), then run
  `vercel link --yes --project <name>`.
- **The first deployment of a project becomes production**, whatever the flags; every later one is
  a preview unless `--prod` is given. Make that first one a deliberate act.
- **`VERCEL_TOKEN` comes from the dashboard.** For a CLI login session Vercel answers
  `403 Cannot create tokens for this app` to both `POST /v3/user/tokens` and `vercel tokens create`.
- **The default domain is `<project>-<suffix>.vercel.app`** when the bare project name is taken
  (here `weather-aware-truck-routing-taupe.vercel.app`). Put the real production domains in
  `ALLOWED_HOSTS` and `VITE_SITE_URL`; preview hosts need no entry, see
  [Backend platform](BACKEND.md#runbook).
- **`vercel deploy --prebuilt` registers the cron** from `.vercel/output/config.json`; the
  deployment object lists it under `crons`.

## Known limitations and follow-ups

- `workflow_dispatch` and `schedule` triggers only work from the default branch, so manual deploys are
  available once `deploy.yml` reaches `main`; previews run from pull requests meanwhile.
- The OpenAPI check enforces `shared/openapi.json` and that the generated types compile today; the
  committed-types comparison starts once `frontend/app/api/schema.d.ts` exists.
- `scripts/migrate-database.sh` bootstraps the roles with `scripts/bootstrap_db.py` (administrator
  connection) and then runs `manage.py migrate --database=owner` (the DDL role), see
  [Backend platform](BACKEND.md#role-model). Both steps were run end to end against a fresh
  PostgreSQL 17 and are safe to re-run; the first real production deployment still has to confirm
  the three repository secrets it needs.
- The preview-deployment measurement of Lighthouse (bypass cookie, `lhci` with `puppeteer-core`)
  cannot run before the Vercel secrets exist, and **no complete Lighthouse run through the bypass
  flow has been seen yet**. What is proven: `scripts/lighthouse-bypass.cjs` is unit tested, and
  against a local server that answers 401 unless it sees the bypass header or the `_vercel_jwt`
  cookie, a real Chrome driven by `lhci collect` authenticated the priming tab with the header
  (2 requests) and the 21 requests that followed carried the cookie alone, none unauthenticated.
  That is HTTP-level cookie authentication only. The Lighthouse run itself ended in
  `NO_NAVSTART` (the page-load trace was not recorded, so there are no scores) and no plain run
  without the bypass flow was completed as a control, so the cause is not established. The first
  real preview deployment is therefore the first full run of this path.
