// Tests of commitlint.config.mjs, the one commit-message rule set of the repository: the pre-commit
// commit-msg hook, and the ci.yml jobs `pr-title` and `commit-lint`, all run it.
//
// Every message goes through the real commitlint CLI with the real config, exactly as the hook and CI
// run it. A rejection is asserted by its reason as well as by its exit code, because a message that
// fails for the wrong reason proves nothing, and each rejected message has a twin in the table that
// must pass (the same helper builds both).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

function read(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

/** The commitlint releases named in a file (`@commitlint/cli@21.2.4`). */
function commitlintPins(relativePath) {
  return [...read(relativePath).matchAll(/@commitlint\/cli@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
}

// The hook is the one place the table takes the release from; the next test holds ci.yml equal to it.
const [version, ...otherHookPins] = commitlintPins(".pre-commit-config.yaml");

// The release comes from the hook, above.
const COMMAND = `npx --yes --package @commitlint/cli@${version} commitlint --config commitlint.config.mjs`;

/** Lints one message with the pinned CLI and the repository config; resolves with the exit code and the output. */
function lint(message) {
  return new Promise((resolve, reject) => {
    // One command string and a shell on every platform: npx is a .cmd file on Windows, and Node 24
    // warns (DEP0190) about a shell with an argument list. The message goes in through stdin.
    const child = spawn(COMMAND, { cwd: root, shell: true });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
    child.stdin.end(`${message}\n`);
  });
}

/** A header of exactly `length` characters (type, scope, a lower-case subject without a full stop). */
function headerOfLength(length) {
  const start = "feat(frontend): ";
  return start + "a".repeat(length - start.length);
}

/** A message with a body line of exactly `length` characters. */
function bodyLineOfLength(length) {
  return `feat(frontend): add a client\n\n${"b".repeat(length)}`;
}

const SCOPE_REASON = /scope must be kebab-case/;

// `reject` is what the output must say when the message must fail; a case without it must pass.
const CASES = [
  // The defect: kebab-case scopes that contain digits.
  { name: "a scope with digits inside a word (e2e)", message: "test(e2e): add the early input spec" },
  { name: "a scope with digits inside a word (a11y)", message: "fix(a11y): label the combobox" },
  { name: "a scope with digits inside a word (i18n)", message: "feat(i18n): add the locale table" },
  { name: "a scope with a digit after a hyphen", message: "test(step-2): number the steps" },
  { name: "a scope that starts with a digit", message: "fix(2fa): check the code" },
  { name: "several scopes, one of them with digits", message: "feat(frontend,e2e): add a spec" },
  // What passed before still passes.
  { name: "a plain kebab-case scope", message: "feat(frontend-api): add a client" },
  { name: "no scope", message: "feat: add a client" },
  { name: "two scopes separated by a slash", message: "feat(frontend/backend): add a client" },
  // What failed before still fails, for the scope's own reason.
  { name: "an upper-case scope", message: "feat(Frontend): add a client", reject: SCOPE_REASON },
  { name: "an upper-case scope with digits", message: "test(E2E): add a spec", reject: SCOPE_REASON },
  { name: "a scope with an upper-case letter after a digit", message: "test(e2E): add a spec", reject: SCOPE_REASON },
  { name: "a scope with an underscore", message: "feat(front_end): add a client", reject: SCOPE_REASON },
  { name: "a scope with a space", message: "feat(front end): add a client", reject: SCOPE_REASON },
  { name: "a scope with an empty segment after a comma", message: "feat(frontend,): add a client", reject: SCOPE_REASON },
  { name: "a scope with an empty segment between slashes", message: "feat(frontend//backend): add a client", reject: SCOPE_REASON },
  { name: "a scope with a leading hyphen", message: "feat(-frontend): add a client", reject: SCOPE_REASON },
  { name: "a scope with a trailing hyphen", message: "feat(frontend-): add a client", reject: SCOPE_REASON },
  { name: "a scope with a doubled hyphen", message: "feat(front--end): add a client", reject: SCOPE_REASON },
  // Every other rule keeps its limit: the header at 72 and the body at 100 stay as they were.
  { name: "a header of 72 characters", message: headerOfLength(72) },
  { name: "a header of 73 characters", message: headerOfLength(73), reject: /\[header-max-length\]/ },
  { name: "a body line of 100 characters", message: bodyLineOfLength(100) },
  { name: "a body line of 101 characters", message: bodyLineOfLength(101), reject: /\[body-max-line-length\]/ },
  { name: "a body without the blank line before it", message: "feat(frontend): add a client\nthe body", reject: /\[body-leading-blank\]/ },
  { name: "a footer without the blank line before it", message: "feat(frontend): add a client\n\nthe body\nCloses #12", reject: /\[footer-leading-blank\]/ },
  { name: "a type outside the list", message: "feature(frontend): add a client", reject: /\[type-enum\]/ },
  { name: "an upper-case type", message: "Feat(frontend): add a client", reject: /\[type-case\]/ },
  { name: "a subject that starts with a capital", message: "feat(frontend): Add a client", reject: /\[subject-case\]/ },
  { name: "a subject that ends with a full stop", message: "feat(frontend): add a client.", reject: /\[subject-full-stop\]/ },
  { name: "no type", message: "add a client", reject: /\[type-empty\]/ },
];

test("commitlint.config.mjs", async (t) => {
  // The first run fetches the package into npx's cache alone; the others then find it and run side by side.
  const [first, ...others] = CASES;
  const results = new Map([[first.message, await lint(first.message)]]);
  const queue = others.map((entry) => entry.message);
  async function worker() {
    for (let message = queue.shift(); message !== undefined; message = queue.shift()) {
      results.set(message, await lint(message));
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));

  for (const entry of CASES) {
    await t.test(entry.reject === undefined ? `accepts ${entry.name}` : `rejects ${entry.name}`, () => {
      const { code, output } = results.get(entry.message);
      if (entry.reject === undefined) {
        assert.equal(code, 0, output);
      } else {
        assert.notEqual(code, 0, `expected a rejection, got: ${output}`);
        assert.match(output, entry.reject);
      }
    });
  }
});

test("the hook, the PR-title job and the commit job run the same commitlint release", () => {
  assert.match(version ?? "", /^\d+\.\d+\.\d+$/, "the pre-commit hook must pin @commitlint/cli");
  assert.deepEqual(otherHookPins, []);
  // pr-title lints the title, commit-lint lints every commit: two jobs, one release.
  assert.deepEqual(commitlintPins(".github/workflows/ci.yml"), [version, version]);
});
