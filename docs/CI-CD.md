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
    CM[Commit messages] --> G
    PH[Pre-commit hooks] --> G
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
| `ci.yml`         | PR, push (integration branch, main), manual | PR title, every commit message, the pre-commit hooks on the changed files, backend (ruff, format, mypy strict, pytest 100 % branch on `postgres:17`), frontend (eslint, prettier, `tokens:check`, tsc, vitest 100 %, build), OpenAPI drift, E2E per Playwright project, `vercel.json` + build dry run |
| `security.yml`   | PR, push, weekly, manual                   | CodeQL (python, javascript-typescript), gitleaks on the full history, dependency review (PR), pip-audit + pnpm audit (high), bandit, OSV-Scanner                                                                 |
| `property-tests.yml` | weekly, manual                   | The property tests with fresh Hypothesis examples (profile `explore`, 2,000 per test) under a printed seed: pull requests use the `ci` profile, which replays the same 500 examples on every run on purpose, see [Property tests](#property-tests) |
| `lighthouse.yml` | called by `ci.yml` (PRs, pushes); manual | `lighthouserc.json` budgets (mobile performance >= 90, accessibility / best practices / SEO = 100, LCP < 2.5 s, CLS < 0.05, TBT < 200 ms on `/` and `/methodology`): **blocking** on `main`, **published but not blocking** on the integration branch until `LIGHTHOUSE_ENFORCE` is switched on, see [Lighthouse](#lighthouse-staged-gate-and-measurement-fidelity) |
| `deploy.yml`     | called by `ci.yml` after the gate; manual  | `vercel pull` > `vercel build` > migrations (production) > `vercel deploy --prebuilt` > smoke > promote (production)                                                                                              |
| `release.yml`    | push to `main`, manual                     | release-please: Conventional Commits > release PR (CHANGELOG, versions) > tag + GitHub Release                                                                                                                    |

Deployments are gated with `needs: [gate]` inside `ci.yml` (not `workflow_run`), so they run on the
very commit CI tested, work from the integration branch, and never run for fork pull requests.
`workflow_dispatch` on `deploy.yml` (input `environment`: preview or production) is offered by GitHub
once the file exists on the default branch.

## Commit and hook checks

Two jobs of `ci.yml` run on pull requests only (like `pr-title`, they are skipped on pushes), and both
are in the needs list of the CI gate, so a red one blocks the merge. They make the commit rules and the
hooks of `.pre-commit-config.yaml` hold for every contributor, whether or not the hooks are installed on
their machine.

| Job           | What it runs                                                                                                  | Why                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commit-lint` | commitlint with `commitlint.config.mjs` on every commit from the base to the head of the pull request         | `pr-title` lints one line, and a rebase-merge puts every commit on the target branch, so each one is held to the rules. A pull request into `main` carries every commit `main` lacks: the whole history of the branch must pass. |
| `pre-commit`  | `pre-commit run --from-ref <base> --to-ref <head>`: the hooks, on the files the pull request changes          | A hook that was never installed locally cannot be skipped by accident. Never `--all-files`: that would fail every pull request on files it did not touch.                                                                         |

A hook is left out of the `pre-commit` job (`SKIP` in `ci.yml`) only when a job of the CI gate already
runs the same check on at least the same files:

| Hook               | Left to                      | Step                                                                                      |
| ------------------ | ---------------------------- | ----------------------------------------------------------------------------------------- |
| `ruff-check`       | `backend`                    | `uv run ruff check .`, the whole backend                                                  |
| `ruff-format`      | `backend`                    | `uv run ruff format --check .`, the whole backend                                         |
| `css-module-types` | `frontend`                   | `pnpm lint`, which starts with `cmk`                                                      |
| `prettier`         | `frontend`                   | `pnpm lint`, which ends with `prettier --check .`, the whole tree                         |
| `eslint`           | `frontend`                   | `pnpm lint`, which runs `eslint .` on the whole tree                                      |
| `gitleaks`         | `pre-commit` (the same job)  | the step "Scan every commit of the pull request for secrets", see below                   |

Two hooks look at the git index, which is empty in a CI checkout, so run as they are they would pass
whatever the pull request holds:

- **gitleaks** scans `--staged` changes. The job skips the hook and runs the same gitleaks release over
  the range `<base>..<head>`: every commit of the pull request, commits of merged branches included. It
  downloads the release archive and checks its sha256 (`GITLEAKS_VERSION` and `GITLEAKS_SHA256` in
  `ci.yml`; a test holds the version equal to the hook's). The "Secret scan" job of `security.yml` is
  outside the CI gate, and no branch rule or ruleset requires it today
  ([BRANCH-PROTECTION.md](BRANCH-PROTECTION.md) lists the rules for the maintainer to apply), so the
  pull request job cannot lean on it (see [Secret scans](#secret-scans)).
- **check-added-large-files** only measures files staged as new. The job runs `git reset --soft` to the
  commit where the branch left the base: every file stays, and every change of the pull request is staged,
  as in a commit.

`check-added-large-files` holds an added file to 500 KB, except a Playwright golden: a PNG in a
`*-snapshots` folder below `frontend/e2e/` may reach 2,048 KB. The hook is listed twice in
`.pre-commit-config.yaml`, with `files` and `exclude` patterns that split the files exactly, and
`scripts/tests/ci-gates.test.mjs` holds both patterns to a table of paths. The ceiling comes from the 20
tracked goldens: the largest is 1,306 KB (`/design` at 390 px wide, a 390 x 32,308 px full page), and the
densest is 0.195 bytes per pixel, so a 1280 x 5,000 px page is 1,219 KB at worst; 2,048 KB is 1.57 times
the largest golden. A golden over the ceiling is a problem of the screenshot (a device pixel ratio above
1, an animation or a map that was not masked, a page that doubled), not a reason to raise the limit.

`end-of-file-fixer` skips `shared/openapi.json` (the generator writes no final newline and
`scripts/openapi.sh check` compares the file byte for byte) and the recorded provider responses (the
`.json` files of `backend/tests/fixtures/providers/routing` and `/weather`, `INDEX.json` excepted). 39 of
them have no final newline because they are the upstream's bytes: `routing/INDEX.json` records the size
and the SHA-256 of each (`stored_bytes`, `stored_sha256`; all 28 match their files), `weather/README.md`
says `sha256sum` reproduces them, and `ReplayCatalog.read_bytes` serves them byte for byte, so a final
newline would make all three wrong. `check-yaml` accepts several documents
in one file (pnpm writes `frontend/pnpm-lock.yaml` as two). The local `prettier` and `eslint` hooks
work on the staged files through `frontend/scripts/precommit/`; the whole tree stays with `pnpm lint`.

### Dependabot

`.github/dependabot.yml` sets no `target-branch`, so Dependabot opens its pull requests against `main`, and
after the final merge `pr-title` and `commit-lint` judge every title and commit it writes. Dependabot's
wording is not ours to change, so the rules bend in two places and nowhere else, and
`scripts/tests/commitlint-config.test.mjs` holds both.

The title of a group of several updates is bounded by the name of the group, so the names are short:
`<prefix>: bump the <group> group[ in <directory>] with <n> updates`, or `across <k> directories` when the
entry lists several. The test builds the longest title of every group of the real file, with two digits for
the counts, and holds it to 72 characters:

| Ecosystem      | Group              | Longest title                                                              | Characters |
| -------------- | ------------------ | -------------------------------------------------------------------------- | ---------- |
| uv             | `py-minor-patch`   | `build(deps): bump the py-minor-patch group in /backend with 99 updates`   | 70         |
| npm            | `npm-minor-patch`  | `build(deps): bump the npm-minor-patch group in /frontend with 99 updates` | 72         |
| github-actions | `actions`          | `ci(deps): bump the actions group across 99 directories with 99 updates`   | 70         |
| pre-commit     | `pre-commit-hooks` | `build(deps): bump the pre-commit-hooks group with 99 updates`             | 60         |

The old names, `python-minor-and-patch`, `npm-minor-and-patch` and `github-actions`, gave 78, 76 and 77.

A title that names the dependencies it bumps is as long as their names, so no group name can bound it: one
update in a group of one or in no group (`bump <dep> from <old> to <new>`), or several updates in no group
(`bump <a>, <b> and <c>`), then ` (via audit fix)`, ` in /<directory>`, ` in the <group> group` and
` across <k> directory` when they apply. Real ones are 87 to 99 characters long (the test links them).
`commitlint.config.mjs` lets a header of exactly that form past `header-max-length`, under `build(deps)` and
`ci(deps)`, the two prefixes of `dependabot.yml`.

Dependabot's commit bodies hold plain lines of 117 to 129 characters: the intro of a group lists package
names when no source link is known, and commitlint already lets a line with a link past the limit. A message
whose header starts like a Dependabot bump and whose footer holds `Signed-off-by: dependabot[bot]
<support@github.com>` may exceed `body-max-line-length`, and every other rule still judges it.

To slip past either exception a human needs, for the header, a title that lists package names after `bump`
(a sentence does not match), and, for the body, such a header plus the bot's signature in the footer, which
says a bot wrote the commit and shows in review and in the log. The two limits keep the log readable and
guard nothing else, so the residual is accepted: a long list of names in a dependency bump, and a long line
of the body under it.

Sources: dependabot-core at commit `7c06280`, `common/lib/dependabot/pull_request_creator/message_builder.rb`
(lines 215 to 350) and `message_builder/title_builder.rb` (lines 61 to 65: the prefix goes before the base
title, and the first word is capitalized only when no prefix precedes it). GitHub's reference says that the
"titles of pull requests are written based on commit messages" and that, for a group, the "branch name and
pull request title are defined by the group" identifier:
<https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference>.

### Secret scans

Two jobs scan for secrets. Both download the gitleaks release that the hook pins (8.30.1), check its
archive against a sha256, and fail closed.

| Job                                         | Runs on                               | Scans                                                                                   |
| ------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| `pre-commit` of `ci.yml`, the gitleaks step | pull requests                         | every commit from the base to the head of the pull request (`<base>..<head>`)           |
| `gitleaks` of `security.yml`                | pull requests, pushes, weekly, manual | every commit reachable from the checked-out commit (`--log-opts="--full-history HEAD"`) |

"Full history" in the name of the second job is the whole history of the commit under test. For a pull
request that is the merge of its head into its base, so a key that an old commit added and a later
commit deleted is found, and so is a key in a commit that a merged branch brought in. The job used to
run `gitleaks/gitleaks-action` v3.0.0, which scanned much less than its name said: for a pull request
it asked the API for one page (30) of the commits (the first pull request that outgrew it had 115),
for a push it scanned only the commits of the event, its weekly schedule never ran (a schedule runs on
the default branch, and `main` has no workflows until the final merge), it ran gitleaks 8.24.3 (its
default) and it did not check the archive it downloaded.

Commits that only another branch holds are not scanned. `--all` would scan every branch ever pushed, and
one planted key on a probe branch would turn every run red; a leaked key on a side branch of this public
repository is just as public, so look there by hand when in doubt (every remote branch fetched, then
`gitleaks git --redact --verbose`). The report of a scan never holds a secret: `--redact` replaces it.

| Pin                  | Release                                          | Where                                                          | Kept current by                                                              |
| -------------------- | ------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| pre-commit           | 4.7.0 (PyPI, released 2026-10-12)                | `PRE_COMMIT_VERSION` in the `pre-commit` job; its cache key    | By hand                                                                      |
| `@commitlint/cli`    | 21.2.4                                           | `pr-title` and `commit-lint` in `ci.yml`, the `commitlint` hook | By hand, all three together: `scripts/tests/commitlint-config.test.mjs` fails when they differ |
| Hook revisions       | pre-commit-hooks v6.0.0, gitleaks v8.30.1        | `.pre-commit-config.yaml`                                      | Dependabot, ecosystem `pre-commit` (weekly, one grouped pull request)        |
| gitleaks (CI scans)  | 8.30.1, the release of the hook                  | `GITLEAKS_VERSION` and `GITLEAKS_SHA256` in the `pre-commit` job of `ci.yml` and the `gitleaks` job of `security.yml` | By hand, with the hook's revision: `scripts/tests/gitleaks-pin.test.mjs` fails when any of the three differs |

A red job reproduces on your machine against the branch the pull request targets (`origin/main` once the
final pull request is merged):

```bash
npx --yes --package @commitlint/cli@21.2.4 commitlint --config commitlint.config.mjs --from origin/main --to HEAD
pre-commit run --from-ref origin/main --to-ref HEAD --show-diff-on-failure

# check-added-large-files only measures files staged as new, so stage the branch as CI does, in a
# throwaway worktree (your own checkout is left alone)
git worktree add --detach ../pr-check HEAD
git -C ../pr-check reset --soft "$(git merge-base origin/main HEAD)"
(cd ../pr-check && pre-commit run check-added-large-files --from-ref origin/main --to-ref HEAD)
git worktree remove --force ../pr-check

# every commit of the branch for secrets (with gitleaks installed)
gitleaks git --redact --verbose --log-opts="origin/main..HEAD"
```

## Property tests

Hypothesis profiles live in `backend/tests/conftest.py`, and each one names its parent and whether it
is derandomised (a profile registered without a parent inherits whichever one is loaded, and on
GitHub that is Hypothesis' own derandomised `ci` profile, which is how the project's `ci` profile
used to be derandomised without anybody saying so, review R2-25).

| Profile   | Used by              | Examples | Randomised | Why                                                                                          |
| --------- | -------------------- | -------- | ---------- | -------------------------------------------------------------------------------------------- |
| `dev`     | local runs (default) | 50       | yes        | A flaky property shows up where it is cheapest to find                                       |
| `ci`      | every pull request   | 500      | no         | The same examples on every run: a red check is the change's own and reproducible, not luck   |
| `explore` | `property-tests.yml` | 2,000    | yes        | The exploration CI cannot do: fresh examples every week, the seed printed, no example database |

A failure found by the weekly run prints its seed and a `@reproduce_failure` blob. Replay it from
`backend/` with `HYPOTHESIS_PROFILE=explore uv run pytest -m hypothesis --hypothesis-seed=<seed>`, or
dispatch the workflow by hand with the same seed. Wall-clock budgets are not property tests: they run
in their own step with `-m perf`, without coverage tracing.

## Required secrets

The pipeline never sets a secret. They live in four places, and the ones only production needs are
not readable from pull request workflows.

**GitHub repository secrets** (Settings > Secrets and variables > Actions). Every workflow run of
the repository can read them, runs for pull requests from branches of this repository included.

| Secret                               | Used by                        | Notes                                                                                                                                                                  |
| ------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERCEL_TOKEN`                       | deploy (preview and production) | A Vercel token made in the dashboard, 90 days: [expiry and rotation](#vercel_token-expiry-and-rotation)                                                                  |
| `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | deploy                         | Identifiers from `.vercel/project.json` after `vercel link`; not credentials                                                                                           |
| `VERCEL_AUTOMATION_BYPASS_SECRET`    | deploy smoke tests, Lighthouse | Vercel Protection Bypass for Automation; previews stay protected, requests send `x-vercel-protection-bypass` (Lighthouse exchanges it for a cookie); [see below](#the-bypass-secret-vercel-exposes-it-to-deployments) |
| `RELEASE_PLEASE_TOKEN` (optional)    | release                        | A PAT or app token. Without it release-please uses `GITHUB_TOKEN` and its release PR gets no CI run (GitHub limitation)                                                |

**GitHub `production` environment secrets** (Settings > Environments > production). Only a job that
declares `environment: production` can read them, and the environment accepts deployments from
`main` only ([details](#the-production-environment)).

| Secret                       | Used by                                      | Notes                                                                                                                       |
| ---------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL_OWNER`         | deploy (production bootstrap and migrations) | Administrator DSN (the Supabase `postgres` user) through the **session** pooler (port 5432, `sslmode=require`)              |
| `HAULCAST_OWNER_DB_PASSWORD` | deploy (production bootstrap and migrations) | Password of the schema-owner role `haulcast_owner` (DDL): the bootstrap creates the role with it, the migrations run as it |
| `HAULCAST_APP_DB_PASSWORD`   | deploy (production bootstrap)                | Password of the least-privilege runtime role `haulcast_app`                                                                 |

**Vercel environment variables** (Project > Settings > Environment Variables). The runtime reads
them; a change applies to deployments created afterwards.

| Variable                                              | Production                    | Preview                        | Notes                                                                                   |
| ----------------------------------------------------- | ----------------------------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| `DJANGO_SECRET_KEY`, `RATE_LIMIT_SALT`, `CRON_SECRET` | its own value, sensitive      | its own value, sensitive       | Different values per environment; production's were generated in memory and are never written to disk, so nobody can read them back |
| `HAULCAST_APP_DB_PASSWORD`                            | shared with preview, sensitive | shared with production, sensitive | [One database](#one-database-for-preview-and-production)                              |
| `DATABASE_URL_POOLED`, `TRUCK_TOP_SPEED_KPH`          | shared                        | shared                         | Configuration, not secret (the pooled URL carries no password)                          |
| `ALLOWED_HOSTS`, `VITE_SITE_URL`                      | shared                        | shared                         | The production domains, see [Production domain](#production-domain)                     |

The owner DSN and the owner password are **never** Vercel variables: the runtime does not need
them. Locally, `.env.local` (gitignored) holds the preview values of the three application secrets
and the database secrets, and deliberately not the production-only application secrets.

Without the Vercel secrets a **preview** deployment is skipped with a visible warning annotation; a
**production** deployment fails loudly (before it touches anything).

## The `production` environment

`production` is a GitHub environment that accepts deployments from the branch `main` only and has
**no required reviewers and no wait timer**: merging the final pull request into `main` is the
approval (D-30). `ci.yml` runs `deploy-production` on that push: a `--prod` build, the database
bootstrap and migrations before anything is promoted, a staged deployment (`--skip-domain`), the
smoke tests, then `vercel promote`.

`deploy.yml` declares `environment: ${{ inputs.environment }}` on its job, so the production call
runs in `production` and reads that environment's secrets, and a preview call runs in `preview`,
which has none. Only the guard step (it requires them for production alone) and the production-only
migration step reference the three database secrets. A preview job resolves them to empty strings
and never needs them. They used to be repository secrets, readable by any workflow run of the
repository.

Created once with the GitHub API (names only; `gh secret set` reads the value from stdin or
the prompt, never from the command line):

```bash
repo=ar27111994/weather-aware-truck-routing
gh api --method PUT "repos/$repo/environments/production" --input - <<'JSON'
{"wait_timer": 0, "reviewers": [], "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
gh api --method POST "repos/$repo/environments/production/deployment-branch-policies" --input - <<'JSON'
{"name": "main", "type": "branch"}
JSON
gh secret set DATABASE_URL_OWNER --env production --repo "$repo"   # likewise the two passwords
```

## One database for preview and production

One Supabase project serves both (D-33). The data is not personal: there are no accounts, only
cached forecasts, plans and rate-limit buckets, and previews sit behind Vercel Authentication. So
preview and production deliberately share the runtime role `haulcast_app`, its password
(`HAULCAST_APP_DB_PASSWORD`) and the pooled connection coordinates. This is an accepted trade-off:
a preview deployment can read and write the same cache, plan and rate-limit tables as production.
The role cannot run DDL, and the owner credentials are never on Vercel.

What stays separate is each environment's application secrets. In particular a different
`RATE_LIMIT_SALT` gives preview traffic different rate-limit buckets than production's.

## Production domain

The live URL is **`https://haulcast-routing.vercel.app`**. `haulcast.vercel.app` is taken: adding it
answers `409 Cannot add haulcast.vercel.app since it's already assigned to another project`. The
domain was added to the Vercel project; the earlier `weather-aware-truck-routing-taupe.vercel.app`
and `weather-aware-truck-routing-ar27111994s-projects.vercel.app` stay. `ALLOWED_HOSTS` lists all
three and `VITE_SITE_URL` (canonical and Open Graph URLs) is the new URL, for Production and Preview.

The variables apply to new deployments only. Until the first production deployment (the merge of
the final pull request, D-30) every production domain serves the placeholder first deployment: the
static pages work, `/api/*` answers 400.

## VERCEL_TOKEN: expiry and rotation

`VERCEL_TOKEN` is a token the maintainer made in the dashboard on 2026-10-20: a 90-day lifetime,
named `weather-aware-truck-routing-ci`. **It expires on 2027-01-18** (the dashboard shows the exact
time; `vercel tokens ls` lists names only). Rotate it by 2027-01-11. An expired token fails the
deploy job at `vercel pull`, before any migration, preview and production alike.

1. Dashboard > Account > Tokens > Create Token: name it `weather-aware-truck-routing-ci-<yyyy-mm>`,
   scope `ar27111994s-projects`, expiration 90 days. Only the dashboard can do this: for a CLI login
   session Vercel answers `403 Cannot create tokens for this app`.
2. In any terminal run `gh secret set VERCEL_TOKEN --repo ar27111994/weather-aware-truck-routing`
   and paste the value at the prompt. Never put it on a command line or in chat.
3. Prove it: the next pull request deploys a preview (the guard step reports the deployment as
   enabled and `vercel pull` passes), or re-run the deploy job of the latest one.
4. Delete the old token on the same dashboard page.

The token is a repository secret because preview deployments need it, so a workflow run from a
branch of this repository can read it. Vercel tokens are scoped to a team, not to an environment, so
a second token for the `production` environment would not narrow what it can do.

## The bypass secret: Vercel exposes it to deployments

`VERCEL_AUTOMATION_BYPASS_SECRET` is a GitHub secret (the smoke tests and Lighthouse send it) and,
on Vercel's side, a system environment variable that every deployment carries. Switching that
exposure off is not possible: `PATCH /v1/projects/<id>/protection-bypass` with `update.isEnvVar`
set to `false` is refused with `400 One bypass must be the VERCEL_AUTOMATION_BYPASS_SECRET
Environment Variable set on deployments`. Vercel's
[documentation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)
says the same: one secret is always set as the variable, and every secret bypasses protection on
every deployment of the project. Pointing the variable at a second, unused secret would only move
the exposure, so we did not.

What holds instead: nothing in the deployed code (`backend/src`, `api/`, `frontend/app`) reads or
logs the variable (only CI scripts read it, from the GitHub secret). A leak would let someone open
this project's protected previews, which serve non-personal data (D-33); the production domains are
public anyway. To rotate, regenerate the secret under Project > Settings > Deployment Protection >
Protection Bypass for Automation, then run `gh secret set VERCEL_AUTOMATION_BYPASS_SECRET`, update
`.env.local` and redeploy: Vercel sets the value when it builds a deployment, so earlier
deployments keep the old one.

## Rotation

- **`VERCEL_TOKEN`:** see above.
- **Production application secrets** (`DJANGO_SECRET_KEY`, `RATE_LIMIT_SALT`, `CRON_SECRET`):
  generate the value in memory and pipe it to the CLI, for example
  `python -c "import secrets,sys; sys.stdout.write(secrets.token_urlsafe(64))" | vercel env add DJANGO_SECRET_KEY --environment production --sensitive --force --yes --project weather-aware-truck-routing --scope ar27111994s-projects`
  (`token_urlsafe(32)` for the other two). The next production deployment picks them up. Nothing
  visible changes for `DJANGO_SECRET_KEY` (no sessions, no cookies); a new `RATE_LIMIT_SALT` starts
  every client with fresh buckets; for `CRON_SECRET` Vercel sends the new value with the first cron
  run after that deployment.
  Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` to the path in `vercel.json` ("The value
  of the variable will be automatically sent as an `Authorization` header when Vercel invokes your
  cron job", [Vercel](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs)) and
  the maintenance endpoint compares exactly that header with `CRON_SECRET`. The production value is
  write-only, so nobody can call the endpoint with it by hand: after a scheduled run, read the cron
  job's logs (Project > Settings > Cron Jobs > View Logs).
- **Database passwords (a short, planned downtime).** Postgres keeps one password per role, so no
  moment exists at which an old and a new deployment can both authenticate; a no-downtime rotation
  would need a second runtime role, which the bootstrap does not create. The bootstrap re-applies
  the role passwords on every run. Pick a quiet moment, then:
  1. Put the new values in the `production` environment (`gh secret set ... --env production`) and
     in `.env.local`, and the new app password in both Vercel targets. Nothing changes live yet:
     deployments keep the variables they were built with.
  2. Run a production deployment (a push to `main`). Its migration step sets the new passwords, so
     from then on the live deployment answers 503 `database_unavailable`. The staged deployment
     carries the new password, passes the smoke tests and is promoted, which ends the window a few
     minutes later.
  3. Preview deployments built earlier keep the old password and fail until their pull request is
     deployed again (preview and production share `haulcast_app`, D-33).
- **`VERCEL_AUTOMATION_BYPASS_SECRET`:** see above.

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
- One Python function, `api/index.py` (region `iad1`, `maxDuration` 40 s: the plan request deadline is
  25 s and the worst case of every budget adds up to 38 s, see `docs/BACKEND.md`, "Time budgets"). `excludeFiles` keeps `frontend/`, `node_modules/`, tests and tooling out of the bundle;
  dependencies come from `api/requirements.txt` (`uv export` of `backend/uv.lock`, drift-checked).
- Rewrites: `/api/(.*)` to the function, then a SPA fallback to `/__spa-fallback.html` for paths
  without a dot outside `/api/` and `/assets/`. Vercel serves existing files (prerendered pages,
  assets) before rewrites, and a missing hashed asset is a 404, not HTML.
- Headers: HSTS (`max-age` 2 years, `includeSubDomains`, `preload`), `nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, COOP/CORP `same-origin`, `X-Frame-Options`, immutable cache for
  `/assets/*`, revalidating cache for everything else, and the CSP below for non-API paths.
- `X-Robots-Tag: noindex, nofollow` on `/design` and everything below it (D-27). The kitchen sink is
  public, as the living style guide, but not for search: the page also carries the `robots` meta tag
  and is not in the sitemap.
- Cron: `GET /api/v1/internal/maintenance` once a day (Hobby limit); Vercel Cron only issues GET, so
  the endpoint accepts GET (Bearer `CRON_SECRET`) and POST for manual runs.

### Content-Security-Policy and the inline scripts

React Router's prerendered HTML contains inline scripts (hydration context, route-module imports with
content-hashed asset names, React's streaming runtime). A strict `script-src 'self'` blocks them and
the page never hydrates, yet their hashes change with every build, so a committed hash would rot.
`scripts/vercel_output.py inject-csp` therefore runs after `vercel build`: it hashes every executable
inline script in the built HTML and appends the hashes to `script-src` in `.vercel/output/config.json`.
Styles follow the same rule (D-25). The committed policy is `style-src 'self'` plus
`style-src-attr 'unsafe-inline'`: stylesheets come from this origin, an inline `<style>` element is
blocked unless its hash is in `style-src`, and `inject-csp` adds the hash of every inline `<style>`
element it finds (there is none today). Style *attributes* stay allowed on purpose: React and React
Aria write them (the position of a slider thumb or a popover), a hash cannot allow an attribute, and
an attribute cannot carry a selector that leaks data the way a `<style>` element can.
`verify` then proves that every inline script is allowed by `script-src` and every inline `<style>`
by `style-src` (or `style-src-elem`, when the policy has one), that `style-src` and `style-src-elem`
never allow `'unsafe-inline'`, that `script-src` never allows `'unsafe-inline'`, `'unsafe-eval'` or
`'strict-dynamic'`, that the Python bundle contains no frontend or test files and that the
static tree and cron registration are complete. CI runs the identical sequence without a Vercel
account (`scripts/vercel-build.sh dry-run`); the deployed `@smoke` Playwright test asserts a clean
console, which is where a CSP violation would show. The no-flash theme script is covered
automatically, and no hash is ever committed.

`verify` reads text, so the same job also lets the browsers judge the result. `scripts/e2e-csp.sh`
serves `.vercel/output` with `scripts/serve-vercel-output.mjs` (the headers of production, hashes
included) and runs `frontend/e2e/csp.spec.ts` in Chromium, Firefox and WebKit: `/`, `/methodology`,
`/design` and `/design/map` must load without a `securitypolicyviolation` event or a CSP console line
and must hydrate (the header's theme toggle answers a click). A violation is reported with the file,
line and column that caused it. A negative control strips the hashes and
expects the page to be blocked, so a pass means the policy was enforced. The only change to the
served policy is that `upgrade-insecure-requests` is dropped in the test: WebKit applies it to
`http://127.0.0.1` and would send every asset request to a TLS port that nothing listens on.
Locally, after `bash scripts/vercel-build.sh dry-run`, run `bash scripts/e2e-csp.sh`; pass Playwright
arguments to narrow it (`--project=csp-webkit --workers=1`).

The map (`/design/map`, and the planner once it shows a plan) is the one page that runs a web worker
and loads third-party data. MapLibre GL JS 6 is told to start its worker from a same-origin asset
(`setWorkerUrl` in `frontend/app/features/map`), so `worker-src` is exactly `'self'`, with no `blob:`
(`scripts/check_vercel_config.py` fails on anything else). The basemap's style, tiles, glyphs and
sprites all come from `https://tiles.openfreemap.org`, the only third-party host in `connect-src` and
`img-src`. `script-src` has no `'unsafe-eval'` and no `'wasm-unsafe-eval'`: nothing on these pages
compiles WebAssembly, and the one library that tried to compile JavaScript from a string, Zod (its
object parsers are generated with `new Function`), runs with `jitless` from `frontend/app/api/zod.ts`.
Without that, Zod probes `new Function("")` when the first schema is created; the policy blocks the
probe and the browser reports it (blocked `eval`) even though Zod catches the error. ESLint keeps every
runtime import of Zod on that module, and `frontend/app/api/zod.test.ts` fails if a schema is created
or parsed through the Function constructor.

### Visual goldens (R1-18)

Twenty screenshots are tagged `@golden`: `/design`, the map harness `/design/map` (with a blank
basemap, so no third-party tile is in the picture), the empty planner, a plan and the methodology
page, each in light and dark at 1280 and 390 px. They run
in the `chromium` project only, on Linux, with `retries: 0`. Pixels depend on the platform's font
rasteriser, so one engine on one platform (the CI runner) owns the baselines, and a golden that needs a
second try is a flaky golden, not a passing one. CI compares against
`frontend/e2e/<spec>.spec.ts-snapshots/*-linux.png` and fails on a difference. On any other
operating system the goldens are skipped, because a comparison there could only be a false alarm.

To make or refresh them after a change you intended, add the label `update-goldens` to the pull request
(or run Actions, Update visual goldens). `goldens.yml` runs the golden tests with
`--update-snapshots=all` on `ubuntu-24.04` and uploads the PNGs as the artifact `goldens-linux`. It
commits nothing: look at the pictures, then download them (`gh run download <run-id> -n goldens-linux`)
and copy the folders into `frontend/e2e/`, then commit them. The label does nothing for a pull request from a fork, because the job runs the pull
request's code.

### Firefox runs headed inside Xvfb, on CI only (D-40)

Firefox runs its graphics probe at every start, headless or not, and the probe needs an X11 or
Wayland display. The GPU-less runner has none, so the probe fails and Firefox blocks WebGL 2, which
MapLibre needs. CI therefore runs only the `firefox` matrix row and the `csp-firefox` project headed
inside `xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24"`, where the probe finds a
display and Mesa's llvmpipe renders WebGL 2 in software; every other project stays headless
everywhere. The opt-in is `E2E_FIREFOX_XVFB=1`, and `playwright.config.ts` refuses it at load time,
naming D-40, unless `CI` is set on Linux with a `DISPLAY`, so it can never open a window on a
developer's machine. Every map test first asserts a WebGL 2 context and fails, naming the engine and
D-40, rather than skipping.

Xvfb starts its pointer at the centre of the screen, which is inside the browser window, and a window
that maps or grows under a still pointer gets real crossing and motion events: those end Playwright's
synthetic hover, which made three hover tests flaky (D-41). So both Xvfb call sites go through
`scripts/e2e-xvfb.sh`. It refuses to run unless `CI` is set on Linux with `E2E_FIREFOX_XVFB=1`, starts
Xvfb with `-noreset`, parks the pointer at the far corner of the screen before any browser starts (the
size is read from the X server), checks the park from a new process, and samples the pointer every
200 ms while the command runs. A pointer that moved, or a window over the park point, fails the step
with `::error::` lines that name D-41, even when every test passed, and so does a watcher that died
early; the log shows the park point, the number of samples and the violations.

`-noreset` is what makes the park last (D-42). An X server resets when its last client disconnects:
`CloseDownClient` in xorg-server `dix/dispatch.c` starts the reset unless the server runs with
`-noreset` (see Xserver(1), option `-noreset`), and a reset puts the pointer back at the screen centre.
A one-shot client, such as one `xdotool` call, is the last client while it runs alone, so without
`-noreset` its exit undoes its own move: the park held inside `xdotool` and read as the centre from the
next process. CI run 39629386862 measured this for an `xdotool` park and for a one-shot python-xlib
`XWarpPointer`, and with `-noreset` both stayed put, even after the last client left. CI run
39605678276 shows the start check failing closed on a server without it (the pointer read 960,540,
not the park point); the check's message now names `-noreset`. Keep the flag. The start check also
proves, with `xwininfo`, that the root window has no child and that the window under the park point
is the root window. Once per Xvfb step the log names the server's argv and extensions, the `xdotool`
version and the screen. After the first browser window is visible, it logs the window tree
(`xwininfo -root -tree`) and the visible windows' geometry 2 s later and again 30 s later, so a window
that covers the park point, or one that grows, shows its size and place. Firefox creates hidden helper
windows first, so the first window of the root is not the trigger.

### Map smoothness (R7)

`frontend/e2e/map.spec.ts` (tag `@perf`, `retries: 0`) holds the R7 budget: no network request while
the timeline is scrubbed, no long task over 50 ms, and a median frame of 18 ms or less (55 fps). On
`/design/map` it first proves its workload on each scene, the shipped OpenFreeMap basemap (the scene
of record) and `?basemap=blank` (our layers alone): the trip is framed as asked, every route vertex is
inside the canvas, every `hc-*` source drew all its features, and all 49 heatmap frames are ready. Then
it sweeps 0 to 48 to 0 hours by keyboard, paced at a presented frame per step (each step must apply
its own frame index, and the cells' state must change across the sweep), and by pointer drag, while
it records long tasks (`PerformanceObserver`), the time between animation frames, every request, and
a Chrome trace of each half (categories `toplevel`, `cc`, `gpu`). The thresholds are the same in both
tiers below; what differs is the renderer, and so what is measured (D-39). When a budget fails, the
rendering technique changes, never the thresholds, the viewport, the scene or the sweep.

- **Tier 1, the budget of record: a hardware GPU, raw numbers.** `pnpm perf:r7:gpu` runs the sweep
  alone through `playwright.gpu.config.ts`, in Chromium's new headless mode (`channel: "chromium"`),
  which draws with the machine's GPU. It fails when the WebGL renderer is a software one (SwiftShader,
  llvmpipe, softpipe, "Software", Microsoft Basic Render), judges the page's own numbers, and appends
  every run, pass or fail, to the log that `PERF_GPU_LOG` names (renderer, browser version, viewport,
  device pixel ratio, host CPU share per sweep half, failed checks). It needs a machine with a GPU, so
  it runs on a developer's machine, not on CI. Reproduce it from `frontend/` with
  `E2E_PORT=<free port> PERF_GPU_LOG=<path>/perf-gpu.json pnpm perf:r7:gpu`; acceptance is three
  consecutive passes.
- **Tier 2, the CI gate on every pull request: a regression proxy on a software renderer.** The
  `chromium` project runs the same test in Playwright's headless shell, which on the GPU-less runner
  draws with SwiftShader and composites in software. Each frame's commit then reads the WebGL canvas
  back on the renderer main thread (`LayerTreeHost::DoUpdateLayers` > `GLES2::ReadPixels` >
  `CommandBufferHelper::Finish`), which measures the rasteriser, not the page. So on a software
  renderer the budget is judged on the trace: a task's corrected time is its raw time minus the
  outermost readbacks under a commit, nothing else (page JavaScript, MapLibre, input, style, layout,
  paint and the rest of the commit all count), and a presented frame owns every task from the one that
  runs its committed `ProxyMain::BeginMainFrame` up to the next such task
  (`frontend/scripts/perf/trace-attribution.ts`, unit-tested on a trimmed CI trace). A software run
  whose trace holds no readback fails, because its correction could not be seen. On a hardware renderer
  no correction applies. CI therefore does not measure the raw frame rate: a corrected 17 ms frame
  could still miss vsync on a GPU, which is why Tier 1 decides R7. CI keeps `perf.json` (raw and
  corrected numbers per scene and sweep half, the renderer, the readback totals) and the gzipped traces
  as the artifact `perf-r7`, pass or fail. Reproduce it locally with
  `pnpm exec playwright test e2e/map.spec.ts --project=chromium --grep @perf`.

### Bundle size: say the unit and the compressor (R1-39)

The first-load budget is **180 kB of gzip** for the JavaScript that `/` and `/methodology` load before
they hydrate: the module preloads, module scripts and inline-bootstrap imports in their prerendered
HTML. Always write the unit and the compressor: KiB is 1024 bytes, kB is 1000 bytes, and gzip level 6
and level 9 differ by about 1 KiB (a report once said "149.4 KB gzip": that was KiB at level 9, about
153 kB). At the R1-fix merge the 12 files are 457.40 KiB raw, 153.19 KiB gzip level 6
(156.9 kB) and 152.12 KiB gzip level 9 (155.8 kB). The code of `/design` is a chunk of its own, and
the style guide has budgets of its own (R3-12): `DESIGN_JS_BUDGET_BYTES.section` for
`/design?section=TextField` and `DESIGN_JS_BUDGET_BYTES.all` for the unfiltered `/design`, both in
`scripts/perf/initial-js.ts` and held by the `@budget` tests of `e2e/bundle-budget.spec.ts`. At
`41a32a4` (probe run 40092296424, Node 24.21.0) a first visit with no input, MapLibre's chunks aside,
downloads 178,270 bytes of gzip level 6 in 25 files on `/design?section=TextField` and 343,111 bytes
in 122 files on `/design`; each budget is that number rounded up to the next 1,000 bytes: 179,000 and
344,000. `e2e/design-system.spec.ts` ("is a chunk of its own") fails if the planner's first load ever
carries it.

The same measurement counts **script files** as well as bytes (P1, D-48). Bytes cannot see the D-35
chunk tax: the style guide's 40 lazy demos made Rollup cut the shared code of every page along them,
which was 20 more files (7.5 kB gzipped) on `/`, and the room that fixing it gives back under 180,000
bytes is about as big as that. So `e2e/bundle-budget.spec.ts` also holds each page to the files that the
same app requests with the demos behind one chunk (`INITIAL_JS_FILE_BUDGETS` in
`scripts/perf/initial-js.ts`: 22 for `/`, 26 for `/methodology`, 18 for the SPA fallback), and
`demoBlindChunks` in `vite.config.ts` is what keeps it there (`docs/adr/demo-blind-chunks.md`). When one
of these checks fails, read the list of files in its report first: a page that asks for more files has
its shared code cut along the demos again, or has grown a chunk of its own.

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
  Expiry and rotation: [VERCEL_TOKEN](#vercel_token-expiry-and-rotation).
- **The default domain is `<project>-<suffix>.vercel.app`** when the bare project name is taken
  (here `weather-aware-truck-routing-taupe.vercel.app`). Put the real production domains in
  `ALLOWED_HOSTS` and `VITE_SITE_URL`; preview hosts need no entry, see
  [Backend platform](BACKEND.md#runbook). The memorable live domain is described under
  [Production domain](#production-domain).
- **`vercel deploy --prebuilt` registers the cron** from `.vercel/output/config.json`; the
  deployment object lists it under `crons`.
- **Turn the preview toolbar off.** On a preview Vercel injects
  `https://vercel.live/_next-live/feedback/feedback.js` into every page for a normal browser (not for
  `HeadlessChrome`). The strict CSP blocks it, so the console shows a violation and the `@smoke`
  CSP test in `deploy.yml` fails on every preview. Set the project's `enablePreviewFeedback` to
  `false` (`PATCH /v9/projects/<id>`, or Project Settings > Vercel Toolbar); it applies to
  deployments created afterwards. The CSP stays strict instead of allowing `vercel.live`.

## Known limitations and follow-ups

- `workflow_dispatch` and `schedule` triggers only work from the default branch, so manual deploys are
  available once `deploy.yml` reaches `main`; previews run from pull requests meanwhile.
- The OpenAPI check enforces `shared/openapi.json` and that the generated types compile today; the
  committed-types comparison starts once `frontend/app/api/schema.d.ts` exists.
- `scripts/migrate-database.sh` bootstraps the roles with `scripts/bootstrap_db.py` (administrator
  connection) and then runs `manage.py migrate --database=owner` (the DDL role), see
  [Backend platform](BACKEND.md#role-model). Both steps were run end to end against a fresh
  PostgreSQL 17 and are safe to re-run; the first real production deployment still has to confirm
  the three secrets of the `production` environment that it needs.
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
