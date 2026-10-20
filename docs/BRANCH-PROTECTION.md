# Branch protection and repository settings (for the maintainer to apply)

Everything here is a one-time setting in the GitHub UI (Settings). Nothing in the repository can
apply it, and the pipelines assume it. Names below are the exact job and environment names.

## Branch `main` (Settings > Branches > Add branch ruleset, target `main`)

| Setting                                             | Value                                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restrict deletions, block force pushes              | on                                                                                                                                                                                                |
| Require a pull request before merging               | on; required approvals 0 while you are the only maintainer (raise to 1 with a second one); dismiss stale approvals on new commits; require review from Code Owners off (all paths are yours)       |
| Require conversation resolution before merging      | on (every CodeRabbit and human thread resolved)                                                                                                                                                   |
| Require status checks to pass                       | on; "Require branches to be up to date" on; required checks: **CI gate**, **PR title (Conventional Commits)**, **Lighthouse / Lighthouse budgets**, **CodeQL (python)**, **CodeQL (javascript-typescript)**, **Secret scan (gitleaks, full history)**, **Dependency review**, **Dependency audit (pip-audit, pnpm audit)**, **Python static analysis (bandit)**, **OSV scan** |
| Require linear history                              | off (the final integration pull request is merged with a merge commit to keep contributors' authorship)                                                                                           |
| Require signed commits                              | off (GitHub rebase-merge re-creates commits unsigned; turn on only if you also stop using rebase-merge)                                                                                           |
| Allow bypassing                                     | nobody (administrators included)                                                                                                                                                                  |

The integration branch `feat/weather-aware-routing` takes the same rule without the "Dependency
review" and "Lighthouse / Lighthouse budgets" requirements being mandatory for hotfix pushes if you
prefer (keep **CI gate** and **PR title**). Lighthouse is staged there on purpose: pull requests into
the integration branch publish their scores (job summary and one sticky comment) but do not block
until the repository variable `LIGHTHOUSE_ENFORCE` is set to `true` (see below).

## Repository settings

- General > Pull Requests: allow **merge commits** and **rebase merging**, disallow squash merging,
  automatically delete head branches.
- Actions > General: workflow permissions "Read repository contents and packages"; tick
  "Allow GitHub Actions to create and approve pull requests" (release-please needs it).
- Code security: enable Dependency graph, Dependabot alerts and security updates, secret scanning
  with push protection, and private vulnerability reporting. Leave CodeQL "default setup" off: the
  `Security` workflow runs it.

## Environments (Settings > Environments)

- `production`: required reviewers = you; deployment branches = `main` only. Every production
  deployment waits for your approval before it runs the migrations and promotes.
- `preview`: no protection rules.

## Secrets (Settings > Secrets and variables > Actions)

See the table in [docs/CI-CD.md](CI-CD.md#required-secrets). Nothing is set by the pipeline code.

## Variables (Settings > Secrets and variables > Actions > Variables)

- `LIGHTHOUSE_ENFORCE`: leave unset (or `false`) while the product pages are being built; set it to
  `true` (`gh variable set LIGHTHOUSE_ENFORCE --body true`) to make a missed Lighthouse budget block
  pull requests into the integration branch as well. Pull requests into `main` always block.

## Vercel

- Project > Settings > Git: disconnect the repository or leave it connected: `vercel.json` sets
  `git.deploymentEnabled: false`, so only the workflow deploys.
- Project > Settings > Deployment Protection: keep **Vercel Authentication** on for previews, create
  a **Protection Bypass for Automation** secret and store it as `VERCEL_AUTOMATION_BYPASS_SECRET`.
- Project > Settings > Environment Variables: set the runtime variables of `.env.example` for
  Production and Preview (`DJANGO_SECRET_KEY`, `ALLOWED_HOSTS`, `DATABASE_URL_POOLED`,
  `HAULCAST_APP_DB_PASSWORD`, `RATE_LIMIT_SALT`, `CRON_SECRET`, ...).
