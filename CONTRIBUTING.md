# Contributing

Haulcast is a monorepo: `backend/` (Django 5.2 + Django Ninja, `uv`), `frontend/` (React 19 +
React Router 7, `pnpm`), `shared/` (cross-stack JSON contracts), `api/` (the Vercel Python entry
point) and `scripts/` (tooling). The pipelines are described in [docs/CI-CD.md](docs/CI-CD.md).

## Setup

Prerequisites: [uv](https://docs.astral.sh/uv/), Node 24.21.0 with pnpm 12, a bash shell (Git Bash
on Windows) and a PostgreSQL 17 for the backend tests (see "Local Postgres" in the README). Node
24.21.0 is the release in `frontend/.nvmrc`; `engines` repeats it, and the bundle-size check can
judge exact equality only on that release.

```bash
uv sync --directory backend --locked
pnpm --dir frontend install --frozen-lockfile
# pre-commit as CI runs it: pinned, with hashes, in .github/tools/pre-commit (.local/ is git-ignored)
uv venv .local/pre-commit
uv pip install --python .local/pre-commit --require-hashes -r .github/tools/pre-commit/requirements.txt
export PATH="$PWD/.local/pre-commit/bin:$PATH"   # Scripts instead of bin on Windows
pre-commit install --install-hooks     # the hooks of .pre-commit-config.yaml (pre-commit and commit-msg)
```

The hooks catch in seconds what CI would otherwise fail on. `default_install_hook_types` in
`.pre-commit-config.yaml` makes that one command install both the `pre-commit` and the `commit-msg`
hook. If git has a global `core.hooksPath` (some tools set one), git runs the hooks of that folder
and never the repository's own, and `pre-commit install` refuses to run: look with
`git config --show-origin --get-all core.hooksPath` and unset it. To run the hooks by hand on what
your branch changes, as CI does: `pre-commit run --from-ref origin/main --to-ref HEAD`.

## The gates (all must be green before a pull request)

```bash
pnpm run check                 # lint + typecheck + tests (100 % coverage) + build, both stacks
pnpm run openapi:check         # shared/openapi.json and the generated types match the backend
pnpm --dir frontend tokens:check  # tokens.css and tokens.ts are what tokens.json generates
pnpm run vercel:check          # vercel.json against the official schema and project invariants
pnpm run vercel:build          # no-account `vercel build` dry run + CSP and bundle verification
pnpm run test:scripts          # tests of the tooling in scripts/
pnpm --dir frontend e2e        # Playwright (chromium, firefox, webkit, Pixel 7, iPhone 14)
```

CI runs the same commands (`.github/workflows/ci.yml`) and, on every pull request, checks more than
they do:

- every commit message of the pull request, and its title, against the commit rules below;
- the pre-commit hooks, on the files the pull request changes;
- the whole tree, not only the changed files: eslint, prettier and ruff in the Frontend and Backend
  jobs (the local eslint and prettier hooks look at the staged files only, to keep a commit fast).

What each job runs, and which hook it leaves to which job, is in
[docs/CI-CD.md](docs/CI-CD.md#commit-and-hook-checks). Coverage is 100 % line and branch on both
stacks; there are no `# type: ignore`, `@ts-ignore`, `eslint-disable` or skipped tests, and no
coverage pragmas without a one-line justification a reviewer accepted.

The frontend coverage run also fails when its data lists a file that has code and no statements
(`frontend/scripts/coverage-gate/blind-spots.ts`, a Vitest reporter that `frontend/vitest.config.ts`
lists). Vitest's v8 provider does not count `export default <expression>`, so a file that is only
that adds nothing to the 100 % and the thresholds cannot see it: write `const name = <expression>;`
and then `export default name;`, as `frontend/app/routes.ts` does.

## When you change ...

- the API: `pnpm run openapi:export`, commit `shared/openapi.json`, regenerate the frontend types
  (`pnpm dlx openapi-typescript@7.13.0 shared/openapi.json -o frontend/app/api/schema.d.ts`).
- backend dependencies: `uv lock`, then `pnpm run requirements:export` and commit
  `api/requirements.txt` (the Vercel function installs from it; CI compares it with `uv.lock`).
- `vercel.json`: keep `script-src 'self'` and `style-src 'self'` as they are (`style-src-attr
  'unsafe-inline'` is deliberate, D-25). The hashes of the prerendered pages' inline scripts and
  `<style>` elements are added at build time (`scripts/vercel_output.py`), so no hash is ever
  committed.
- a design token (colour, size, breakpoint): edit `frontend/app/design-system/tokens/tokens.json`,
  run `pnpm --dir frontend tokens` and commit what it writes. A literal colour, size or breakpoint
  in a stylesheet fails `css-contract.test.ts`; query widths come from the token scale.
- a string the product shows: it lives in `foundation/microcopy.json`, which is a copy of the design
  contract's file. Change the contract first, then copy it over that file and over
  `foundation/__fixtures__/design-contract.microcopy.json`; `microcopy-contract.test.ts` fails when
  they differ. The voice rules (no emoji, dashes, arrows or exclamation marks) live in
  `frontend/test/voice.ts` and are tested on `/design`'s component descriptions as well.
- anything that moves a pixel of `/design`: refresh the visual goldens on the Linux runner (add the
  label `update-goldens` to the pull request, then commit the PNGs of the `goldens-linux` artifact;
  see "Visual goldens" in docs/CI-CD.md). Goldens made on another operating system are not used.
- frontend tests: `frontend/test/` holds the shared helpers (`states.ts` for hover, press and focus
  states, `controlled.tsx` for the controlled-value contract, `match-media.ts`, `axe.ts`). A test
  that logs a console error or warning fails unless it says so with `allowConsole`
  (`test/console-guard.ts`). Under `installFakeTimers()` wait with `findUnderFakeTimers()`
  (`test/fake-timers.ts`), never `findBy*` or `waitFor`: a test that times out inside them leaves a
  loop that never ends and wedges the Vitest worker. A lint rule enforces it. A failing property
  test prints its seed; replay it with
  `FC_SEED=<seed> pnpm --dir frontend test`.

## Commits and branches

- [Conventional Commits 1.0](https://www.conventionalcommits.org/): `feat(backend): ...`,
  `fix(frontend): ...`, `ci: ...`, `docs: ...`. The header (type, scope and subject) is at most 72
  characters; the subject is imperative, starts in lower case and has no full stop. The scope is
  kebab-case: lower-case letters and digits joined by single hyphens, so `test(e2e)` and
  `fix(a11y)` pass and `feat(Frontend)` or `feat(front_end)` do not. Body lines are at most 100
  characters, explain *why*, and follow a blank line; a footer follows another blank line. One
  logical change per commit. `commitlint.config.mjs` enforces this on every commit message (the
  `commit-msg` hook and, for every commit of a pull request, CI) and on pull-request titles (CI).
- Branch from `main`, one branch (and git worktree) per task, and open a pull request into `main`;
  the maintainer merges it with **rebase-merge** after CI is green.
- Before merging, request a CodeRabbit review (`@coderabbitai review`)
  and handle every thread and summary comment: fix what is valid (with tests), answer what is not,
  resolve all threads.

## Security

Never commit secrets or `.env*` files (only `.env.example`). Report vulnerabilities privately, see
[SECURITY.md](SECURITY.md).
