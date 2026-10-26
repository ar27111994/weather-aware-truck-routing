// The gitleaks scan of the `pre-commit` job in ci.yml downloads its own gitleaks (the hook cannot scan
// a pull request: it reads the git index). The release must be the one the hook pins in
// .pre-commit-config.yaml, which Dependabot bumps, so this test fails the pull request that bumps one
// and not the other.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

test("the gitleaks of the pull request scan is the release the hook pins", () => {
  const hook = /repo: https:\/\/github\.com\/gitleaks\/gitleaks\s+rev: v(\d+\.\d+\.\d+)/.exec(
    read(".pre-commit-config.yaml"),
  );
  const job = /GITLEAKS_VERSION: (\d+\.\d+\.\d+)/.exec(read(".github/workflows/ci.yml"));
  assert.ok(hook, "the pre-commit config must pin the gitleaks hook");
  assert.ok(job, "ci.yml must pin GITLEAKS_VERSION");
  assert.equal(job[1], hook[1]);
});

test("the gitleaks archive is checked against a sha256", () => {
  assert.match(read(".github/workflows/ci.yml"), /GITLEAKS_SHA256: [0-9a-f]{64}\n/);
});
