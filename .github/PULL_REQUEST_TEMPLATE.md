## Summary

<!-- What changes and why, in two or three sentences. Link the issue or card. -->

## Changes

<!-- The notable decisions (the diff shows the rest). -->

## Verification

<!-- Paste the real output tails of the gates you ran. "It should work" is not evidence. -->

## Checklist (mirrors `.planning/QUALITY-GATES.md`; tick what applies, explain what does not)

**Gates, run locally before pushing**

- [ ] Backend: `ruff check`, `ruff format --check`, `mypy --strict src`, `pytest --cov --cov-branch --cov-fail-under=100` (real PostgreSQL, never SQLite)
- [ ] Frontend: `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage` (100 % lines, branches, functions, statements), `pnpm build`
- [ ] E2E (when UI or API behaviour changed): Playwright on chromium, firefox, webkit, Pixel 7 and iPhone 14; axe on every new state; goldens updated on purpose
- [ ] API changed: `pnpm run openapi:export` committed, generated frontend types regenerated, `docs/API.md` updated
- [ ] Backend dependencies changed: `pnpm run requirements:export` committed (CI compares `api/requirements.txt` with `uv.lock`)

**Quality**

- [ ] No hacks: no `# type: ignore`, `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, skipped tests or coverage pragmas without a one-line justification a reviewer accepted
- [ ] New behaviour has tests (unit, property, integration, contract, concurrency, security as relevant to the change)
- [ ] Docs updated (README, `docs/`, ADR for a locked decision), no TODO or FIXME left behind

**Security (`QUALITY-GATES.md` section 4)**

- [ ] No secret, token or `.env*` value in the diff, the PR text or the logs pasted above
- [ ] Input validated server-side; no user-controlled value reaches SQL, a shell or an outbound URL; errors leak nothing
- [ ] Headers, CORS, rate limits and CSP unaffected, or the change is reviewed against checklist items 17 and 19

**Process**

- [ ] The PR title is a Conventional Commit (`feat(backend): ...`); commits are small and logical
- [ ] UI change: full-page screenshots attached (desktop and mobile, light and dark)
- [ ] CI is green, and every CodeRabbit thread is resolved or answered with a justification
