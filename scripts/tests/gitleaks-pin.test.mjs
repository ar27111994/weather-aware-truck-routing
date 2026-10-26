// Two jobs scan for secrets with a gitleaks that they download themselves, and both must run the
// release that the gitleaks hook of .pre-commit-config.yaml pins (the pre-commit ecosystem of
// Dependabot bumps that line, so this test fails the pull request that bumps one and not the others):
//
// - the `pre-commit` job of ci.yml scans every commit of a pull request (the hook cannot: it reads
//   the git index);
// - the `gitleaks` job of security.yml scans the whole history of the checked-out commit, on every
//   pull request, on every push to the integration branch and main, weekly, and on demand. It used to
//   run gitleaks/gitleaks-action, which scans none of that (docs/CI-CD.md, "Secret scans").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const CI = ".github/workflows/ci.yml";
const SECURITY = ".github/workflows/security.yml";

function read(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

/** The text of one job of a workflow: from `  <id>:` up to the next job, or the end of the file. */
function jobBlock(workflow, id) {
  const lines = read(workflow).split("\n");
  const start = lines.indexOf(`  ${id}:`);
  assert.notEqual(start, -1, `${workflow} has no job ${id}`);
  const next = lines.slice(start + 1).findIndex((line) => /^ {2}\S/.test(line));
  return lines.slice(start, next === -1 ? undefined : start + 1 + next).join("\n");
}

/** The gitleaks release and the sha256 of its Linux archive that a job pins. */
function pins(workflow, id) {
  const job = jobBlock(workflow, id);
  return {
    version: /GITLEAKS_VERSION: (\d+\.\d+\.\d+)\n/.exec(job)?.[1],
    sha256: /GITLEAKS_SHA256: ([0-9a-f]{64})\n/.exec(job)?.[1],
  };
}

const hook = /repo: https:\/\/github\.com\/gitleaks\/gitleaks\s+rev: v(\d+\.\d+\.\d+)/.exec(
  read(".pre-commit-config.yaml"),
);

test("both gitleaks scans run the release that the hook pins", () => {
  assert.ok(hook, "the pre-commit config must pin the gitleaks hook");
  assert.equal(pins(CI, "pre-commit").version, hook[1], `${CI} (job pre-commit)`);
  assert.equal(pins(SECURITY, "gitleaks").version, hook[1], `${SECURITY} (job gitleaks)`);
});

test("both gitleaks archives are checked against the same sha256", () => {
  const ci = pins(CI, "pre-commit");
  const security = pins(SECURITY, "gitleaks");
  assert.match(ci.sha256 ?? "", /^[0-9a-f]{64}$/, `${CI} must pin GITLEAKS_SHA256`);
  assert.equal(security.sha256, ci.sha256, `${SECURITY} must pin the same GITLEAKS_SHA256`);
  for (const [workflow, id] of [
    [CI, "pre-commit"],
    [SECURITY, "gitleaks"],
  ]) {
    assert.match(jobBlock(workflow, id), /sha256sum --check/, `${workflow} must check the archive`);
  }
});

test("the gitleaks job of security.yml scans the whole history of the checked-out commit", () => {
  const job = jobBlock(SECURITY, "gitleaks");
  // The action asks the API for one page (30) of the commits of a pull request, scans only the
  // commits of a push event, and downloads gitleaks without checking it.
  assert.doesNotMatch(job, /gitleaks-action/, "the action does not scan the whole history");
  assert.match(job, /fetch-depth: 0\n/, "the checkout must hold every commit");
  assert.match(job, /git rev-parse --is-shallow-repository/, "a shallow clone must fail the job");
  const scan = /gitleaks" git [^\n]*--log-opts="([^"]*)"/.exec(job);
  assert.ok(scan, "the job must run the downloaded gitleaks over git history with --log-opts");
  // Every commit reachable from HEAD: no range that would leave the older commits out, and not
  // --all, which would also scan every other branch (a planted key on a probe branch would turn
  // every run red).
  assert.equal(scan[1], "--full-history HEAD");
});
