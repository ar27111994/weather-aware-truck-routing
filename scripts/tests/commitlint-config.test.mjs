// Tests of commitlint.config.mjs, the one commit-message rule set of the repository: the pre-commit
// commit-msg hook, and the ci.yml jobs `pr-title` and `commit-lint`, all run it.
//
// Every message goes through the real commitlint CLI (the release that CI pins) with the real config.
// The table runs the way the `commit-lint` job runs: one commit per message in a temporary repository,
// then ONE `commitlint --config ... --from <base> --to HEAD --verbose`. Starting the CLI costs seconds,
// so a process per message made this file the slowest of the script tests. The other two wirings keep a
// run of their own: a title on stdin (the `pr-title` job) and `--edit <file>` (the commit-msg hook).
// A rejection is asserted by its reason as well as by its exit code, because a message that fails for
// the wrong reason proves nothing, and each rejected message has a twin in the table that must pass
// (the same helper builds both).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

function read(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

/** The commitlint releases named in a file (`@commitlint/cli@21.2.4`). */
function commitlintPins(relativePath) {
  return [...read(relativePath).matchAll(/@commitlint\/cli@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
}

// The hook is the one place the table takes the release from; the last test holds ci.yml equal to it.
const [version, ...otherHookPins] = commitlintPins(".pre-commit-config.yaml");

// The release comes from the hook, above. A shell on every platform: npx is a .cmd file on Windows, and
// Node 24 warns (DEP0190) about a shell with an argument list, so each run is one command string.
const CLI = `npx --yes --package @commitlint/cli@${version} commitlint`;

/** Runs a command string in a shell; resolves with the exit code and the output (stdout and stderr). */
function run(command, { cwd = root, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
    child.stdin.end(input);
  });
}

/** One message on stdin: how the `pr-title` job lints a title. */
function lintOnStdin(message) {
  return run(`${CLI} --config commitlint.config.mjs`, { input: `${message}\n` });
}

/** One message in a file: how the commit-msg hook lints it (`--edit <file>`); `name` keeps parallel runs apart. */
async function lintInFile(message, directory, name) {
  const file = join(directory, name);
  writeFileSync(file, `${message}\n`);
  return run(`${CLI} --config commitlint.config.mjs --edit "${file}"`);
}

// The CLI colors its output when the terminal it runs in does (the test runner may be one).
const ANSI_COLOR = /\u001b\[[0-9;]*m/g;

/**
 * Splits the output of `commitlint --verbose` over a range into one entry per commit, newest first:
 * the message it linted, whether it passed, and the lines that judge it.
 */
function parseVerbose(output) {
  const entries = [];
  let current = null;
  for (const line of output.replace(ANSI_COLOR, "").split(/\r?\n/)) {
    if (line.startsWith("\u29D7   --- input ---")) {
      current = { input: [], verdict: [] };
      entries.push(current);
    } else if (current !== null) {
      const judged = current.verdict.length > 0 || line.startsWith("\u2716   ") || line.startsWith("\u2714   ");
      current[judged ? "verdict" : "input"].push(line);
    }
  }
  return entries.map(({ input, verdict }) => ({
    message: input.join("\n").replace(/\n+$/, ""),
    verdict: verdict.join("\n"),
    passed: verdict.some((line) => /found 0 problems/.test(line)),
  }));
}

/**
 * Lints the messages as the `commit-lint` job lints a pull request: one commit per message on top of a
 * base commit (a single `git fast-import`, so the messages are stored byte for byte), then one run of the
 * CLI over the range. Resolves with the exit code, the output and one parsed entry per message, in the
 * order of `messages`.
 */
async function lintRange(messages) {
  const directory = mkdtempSync(join(tmpdir(), "commitlint-range-"));
  try {
    execFileSync("git", ["init", "-q", "--initial-branch=main", directory]);
    let stream = "";
    [["chore: base"], ...messages.map((message) => [message])].forEach(([message], index) => {
      const data = `${message}\n`;
      stream += `commit refs/heads/main\nmark :${index + 1}\n`;
      stream += `author Table <table@example.com> ${1_700_000_000 + index} +0000\n`;
      stream += `committer Table <table@example.com> ${1_700_000_000 + index} +0000\n`;
      stream += `data ${Buffer.byteLength(data)}\n${data}\n`;
      stream += index === 0 ? "\n" : `from :${index}\n\n`;
    });
    execFileSync("git", ["fast-import", "--quiet"], { cwd: directory, input: Buffer.from(stream) });
    const base = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
    const config = join(root, "commitlint.config.mjs");
    const { code, output } = await run(`${CLI} --config "${config}" --from ${base} --to HEAD --verbose`, { cwd: directory });
    // The CLI lists the newest commit first. It prints the message rebuilt from its parts (a blank line
    // between header, body and footer), so a row is matched by its header and its place in the range.
    const entries = parseVerbose(output).reverse();
    assert.equal(entries.length, messages.length, `commitlint judged ${String(entries.length)} commits:\n${output}`);
    entries.forEach((entry, index) => {
      const header = messages[index]?.split("\n")[0];
      assert.equal(entry.message.split("\n")[0], header, "commitlint judged another commit than the one in this row");
    });
    return { code, output, entries };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  { name: "scopes separated by a comma and one space", message: "feat(frontend, backend): add a client" },
  // What failed before still fails, for the scope's own reason.
  { name: "an upper-case scope", message: "feat(Frontend): add a client", reject: SCOPE_REASON },
  { name: "an upper-case scope with digits", message: "test(E2E): add a spec", reject: SCOPE_REASON },
  { name: "a scope with an upper-case letter after a digit", message: "test(e2E): add a spec", reject: SCOPE_REASON },
  { name: "a scope with an underscore", message: "feat(front_end): add a client", reject: SCOPE_REASON },
  { name: "a scope with a space", message: "feat(front end): add a client", reject: SCOPE_REASON },
  { name: "a scope with an empty segment after a comma", message: "feat(frontend,): add a client", reject: SCOPE_REASON },
  { name: "a scope with an empty segment between slashes", message: "feat(frontend//backend): add a client", reject: SCOPE_REASON },
  { name: "scopes separated by a comma and two spaces", message: "feat(frontend,  backend): add a client", reject: SCOPE_REASON },
  { name: "an empty scope", message: "feat(): add a client", reject: SCOPE_REASON },
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

/** The title the `pr-title` job and the hook are tried with, and a title that both must refuse. */
const ACCEPTED = "feat(frontend): add a client";
const REFUSED = headerOfLength(73);

/** Starts a run now and hands its result, or its error, to the test that asks for it. */
function startNow(promise) {
  const result = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  return async () => {
    const { value, error } = await result;
    if (error !== undefined) {
      throw error;
    }
    return value;
  };
}

// The three wirings are started together: starting the CLI is what takes the time, so the file costs
// about one start, not one per wiring.
const editDirectory = mkdtempSync(join(tmpdir(), "commitlint-edit-"));
after(() => rmSync(editDirectory, { recursive: true, force: true }));
const rangeRun = startNow(lintRange(CASES.map((entry) => entry.message)));
const stdinRuns = startNow(Promise.all([lintOnStdin(ACCEPTED), lintOnStdin(REFUSED)]));
const editRuns = startNow(
  Promise.all([lintInFile(ACCEPTED, editDirectory, "ACCEPTED_EDITMSG"), lintInFile(REFUSED, editDirectory, "REFUSED_EDITMSG")]),
);

test("commitlint.config.mjs, over a range of commits as the commit-lint job runs it", async (t) => {
  const { code, output, entries } = await rangeRun();
  assert.equal(code !== 0, CASES.some((entry) => entry.reject !== undefined), output);
  for (const [index, entry] of CASES.entries()) {
    await t.test(entry.reject === undefined ? `accepts ${entry.name}` : `rejects ${entry.name}`, () => {
      const judged = entries[index];
      if (entry.reject === undefined) {
        assert.ok(judged?.passed, judged?.verdict);
      } else {
        assert.ok(judged !== undefined && !judged.passed, `expected a rejection, got: ${judged?.verdict}`);
        assert.match(judged.verdict, entry.reject);
      }
    });
  }
});

test("a title on stdin, as the pr-title job lints it", async () => {
  const [accepted, refused] = await stdinRuns();
  assert.equal(accepted.code, 0, accepted.output);
  assert.notEqual(refused.code, 0, `expected a rejection, got: ${refused.output}`);
  assert.match(refused.output, /\[header-max-length\]/);
});

test("a message in a file, as the commit-msg hook lints it (--edit)", async () => {
  const [accepted, refused] = await editRuns();
  assert.equal(accepted.code, 0, accepted.output);
  assert.notEqual(refused.code, 0, `expected a rejection, got: ${refused.output}`);
  assert.match(refused.output, /\[header-max-length\]/);
});

test("the hook, the PR-title job and the commit job run the same commitlint release", () => {
  assert.match(version ?? "", /^\d+\.\d+\.\d+$/, "the pre-commit hook must pin @commitlint/cli");
  assert.deepEqual(otherHookPins, []);
  // pr-title lints the title, commit-lint lints every commit: two jobs, one release.
  assert.deepEqual(commitlintPins(".github/workflows/ci.yml"), [version, version]);
});
