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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The table below runs the release that the hook pins, which is what a contributor's commit-msg hook runs;
// the guard at the end of this file holds that release equal to the manifest that Dependabot reads.
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

// ---- Dependabot ------------------------------------------------------------------------------------
// What Dependabot writes, and what this repository's .github/dependabot.yml can make of it. The titles
// come from `pr_name` of dependabot-core (common/lib/dependabot/pull_request_creator/message_builder.rb
// at commit 7c06280, lines 215-350):
//   several updates in a group  bump the <group> group[ in <directory>] with <n> update[s]       (294-300, 333-336)
//   several directories         bump the <group> group across <k> directories with <n> updates   (305-320)
//   one update in a group       bump <dep> from <old> to <new>[ (via audit fix)][ in <directory>] in the <group> group
//                               [ across <k> directory]                                          (215-217, 240, 297, 315)
//   one update, no group        bump <dep> from <old> to <new>[ (via audit fix)][ in <directory>]
// preceded by the `commit-message` prefix and a colon. The commit subject is that title cut down to 72
// characters at " from ... to ..." and then at the first " in " (lines 340-350), which cannot shorten
// the "across <k> directories" form. GitHub's documentation says the title follows the commit message
// ("Since the titles of pull requests are written based on commit messages, this setting also impacts
// the titles of pull requests") and, for a group, the group's name ("When pull requests are raised for
// grouped updates, the branch name and pull request title are defined by the group `IDENTIFIER`"):
// https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference
//
// A title that names one dependency is as long as the name, so no group name can bound it; the config
// lets such a title (and only such a title) past the 72 characters. The titles of a group of several
// updates are bounded by the name of the group, which is held to 72 here, in the worst case (two digits
// for the updates, and for the directories).
//
// Dependabot's commits end with `Signed-off-by: dependabot[bot] <support@github.com>`. commitlint lets a
// line that holds a link exceed the body limit, and most of Dependabot's long lines are such lines, but
// the intro line is a plain list of names when no source link is known, and then it can be 100+ characters.

// Real Dependabot commits, copied verbatim from public repositories (the URL of each is above it).
const DEPENDABOT_COMMITS = [
  {
    name: "a group in /backend, two updates, the metadata block and the trailer",
    // https://github.com/yaeouk-rajab/pulsewatch/commit/b7a32aaade61d0d90963e6a81256b59a8a704d2a
    message: [
      "build(deps): bump the minor-and-patch group in /backend with 2 updates",
      "",
      "Bumps the minor-and-patch group in /backend with 2 updates: golang and alpine.",
      "",
      "",
      "Updates `golang` from 1.25-alpine to 1.27-alpine",
      "",
      "Updates `alpine` from 3.20 to 3.24",
      "",
      "---",
      "updated-dependencies:",
      "- dependency-name: golang",
      "  dependency-version: 1.27-alpine",
      "  dependency-type: direct:production",
      "  dependency-group: minor-and-patch",
      "- dependency-name: alpine",
      "  dependency-version: '3.24'",
      "  dependency-type: direct:production",
      "  update-type: version-update:semver-minor",
      "  dependency-group: minor-and-patch",
      "...",
      "",
      "Signed-off-by: dependabot[bot] <support@github.com>",
    ].join("\n"),
  },
  {
    name: "a group in /backend whose intro line is 232 characters long and holds links",
    // https://github.com/ytkg/masusono-blog/commit/65093326027ef43d6fc33c388c4a31ba20cb179c
    message: [
      "build(deps): bump the mui group in /backend with 2 updates (#608)",
      "",
      "* build(deps): bump the mui group in /backend with 2 updates",
      "",
      "Bumps the mui group in /backend with 2 updates: [@mui/icons-material](https://github.com/mui/material-ui/tree/HEAD/packages/mui-icons-material) and [@mui/material](https://github.com/mui/material-ui/tree/HEAD/packages/mui-material).",
      "",
      "",
      "Updates `@mui/icons-material` from 9.2.0 to 9.4.0",
      "- [Release notes](https://github.com/mui/material-ui/releases)",
      "- [Changelog](https://github.com/mui/material-ui/blob/master/CHANGELOG.md)",
      "- [Commits](https://github.com/mui/material-ui/commits/v9.4.0/packages/mui-icons-material)",
      "",
      "Updates `@mui/material` from 9.2.0 to 9.4.0",
      "- [Release notes](https://github.com/mui/material-ui/releases)",
      "- [Changelog](https://github.com/mui/material-ui/blob/master/CHANGELOG.md)",
      "- [Commits](https://github.com/mui/material-ui/commits/v9.4.0/packages/mui-material)",
      "",
      "---",
      "updated-dependencies:",
      "- dependency-name: \"@mui/icons-material\"",
      "  dependency-version: 9.4.0",
      "  dependency-type: direct:production",
      "  update-type: version-update:semver-minor",
      "  dependency-group: mui",
      "- dependency-name: \"@mui/material\"",
      "  dependency-version: 9.4.0",
      "  dependency-type: direct:production",
      "  update-type: version-update:semver-minor",
      "  dependency-group: mui",
      "...",
      "",
      "Signed-off-by: dependabot[bot] <support@github.com>",
      "",
      "* test: stabilize trend selection during element screenshots",
      "",
      "---------",
      "",
      "Signed-off-by: dependabot[bot] <support@github.com>",
      "Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>",
      "Co-authored-by: Yoshiki Takagi <yoshiki.tkg@gmail.com>",
    ].join("\n"),
  },
  {
    name: "a group in /frontend under the chore(deps) prefix",
    // https://github.com/NexusAgentX/Oh-My-AIHub/commit/51a95687631067c800f7eaecf74dbbfe8cb0924c
    message: [
      "chore(deps): bump the frontend-docker group in /frontend with 2 updates",
      "",
      "Bumps the frontend-docker group in /frontend with 2 updates: node and nginx.",
      "",
      "",
      "Updates `node` from 24.20.0-alpine to 24.21.0-alpine",
      "",
      "Updates `nginx` from 1.29-alpine to 1.31-alpine",
      "",
      "---",
      "updated-dependencies:",
      "- dependency-name: node",
      "  dependency-version: 24.21.0-alpine",
      "  dependency-type: direct:production",
      "  update-type: version-update:semver-minor",
      "  dependency-group: frontend-docker",
      "- dependency-name: nginx",
      "  dependency-version: 1.31-alpine",
      "  dependency-type: direct:production",
      "  dependency-group: frontend-docker",
      "...",
      "",
      "Signed-off-by: dependabot[bot] <support@github.com>",
    ].join("\n"),
  },
];

// Real commits of repositories that set no `commit-message.prefix`: their title is Dependabot's default,
// which has no prefix and starts with a capital. Dependabot builds a title as the prefix followed by the base
// title, and capitalizes the first word only when no prefix precedes it (title_builder.rb, lines 61-65 at the
// same commit), and the body does not depend on the prefix. `withPrefix` turns such a commit into the same
// update under `commit-message.prefix: build(deps)`, which this repository's dependabot.yml sets, and changes
// nothing else. The long lines of these bodies are plain lists of names without a link.
const DEPENDABOT_UNPREFIXED_COMMITS = [
  {
    name: "a group in /backend whose intro line is a plain list of names, 117 characters",
    // https://github.com/mbianchidev/pdf-tools/commit/8c6a19400ba4fe711bbd834f7a751a2914cf05f3
    message: [
      "Bump the all-dependencies group in /backend with 2 updates",
      "",
      "Bumps the all-dependencies group in /backend with 2 updates: software.amazon.awssdk:bom and org.apache.poi:poi-ooxml.",
      "",
      "",
      "Updates `software.amazon.awssdk:bom` from 2.55.16 to 2.57.1",
      "",
      "Updates `org.apache.poi:poi-ooxml` from 5.5.1 to 6.0.0",
      "",
      "---",
      "updated-dependencies:",
      "- dependency-name: software.amazon.awssdk:bom",
      "  dependency-version: 2.57.1",
      "  dependency-type: direct:production",
      "  update-type: version-update:semver-minor",
      "  dependency-group: all-dependencies",
      "- dependency-name: org.apache.poi:poi-ooxml",
      "  dependency-version: 6.0.0",
      "  dependency-type: direct:production",
      "  update-type: version-update:semver-major",
      "  dependency-group: all-dependencies",
      "...",
      "",
      "Signed-off-by: dependabot[bot] <support@github.com>",
    ].join("\n"),
  },
  {
    name: "a second group whose intro line is a plain list of names, 129 characters",
    // https://github.com/mbianchidev/pdf-tools/commit/cf78774cedc7a0e6331cbb82f27b8e4e05bcdbfc
    message: [
      "Bump the all-dependencies group in /backend with 2 updates",
      "",
      "Bumps the all-dependencies group in /backend with 2 updates: software.amazon.awssdk:bom and org.verapdf:validation-model-jakarta.",
      "",
      "",
      "Updates `software.amazon.awssdk:bom` from 2.55.12 to 2.55.16",
      "",
      "Updates `org.verapdf:validation-model-jakarta` from 1.30.2 to 1.30.3",
      "",
      "---",
      "updated-dependencies:",
      "- dependency-name: software.amazon.awssdk:bom",
      "  dependency-version: 2.55.16",
      "  dependency-type: direct:production",
      "  update-type: version-update:semver-patch",
      "  dependency-group: all-dependencies",
      "- dependency-name: org.verapdf:validation-model-jakarta",
      "  dependency-version: 1.30.3",
      "  dependency-type: direct:production",
      "  update-type: version-update:semver-patch",
      "  dependency-group: all-dependencies",
      "...",
      "",
      "Signed-off-by: dependabot[bot] <support@github.com>",
    ].join("\n"),
  },
  {
    name: "a group whose intro line is a plain list of names, 122 characters",
    // https://github.com/the-dibujitos-dp2/ccpip-marketplace/commit/8dcf773dbf5ca9df5df3ae1fa7f9afb7b9e95a87
    message: [
      "Bump the menores group in /backend with 2 updates (#113)",
      "",
      "Bumps the menores group in /backend with 2 updates: com.twelvemonkeys.imageio:imageio-webp and software.amazon.awssdk:bom.",
      "",
      "",
      "Updates `com.twelvemonkeys.imageio:imageio-webp` from 3.15.2 to 3.15.3",
      "",
      "Updates `software.amazon.awssdk:bom` from 2.55.11 to 2.55.16",
      "",
      "---",
      "updated-dependencies:",
      "- dependency-name: com.twelvemonkeys.imageio:imageio-webp",
      "  dependency-version: 3.15.3",
      "  dependency-type: direct:production",
      "  update-type: version-update:semver-patch",
      "  dependency-group: menores",
      "- dependency-name: software.amazon.awssdk:bom",
      "  dependency-version: 2.55.16",
      "  dependency-type: direct:production",
      "  update-type: version-update:semver-patch",
      "  dependency-group: menores",
      "...",
      "",
      "Signed-off-by: dependabot[bot] <support@github.com>",
      "Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>",
    ].join("\n"),
  },
];

/** The message as Dependabot writes it when `commit-message.prefix` is `prefix`. */
function withPrefix(message, prefix) {
  return `${prefix}: ${message.charAt(0).toLowerCase()}${message.slice(1)}`;
}

// A real pull request title of a group with one update, 87 characters: https://github.com/Alexandru2984/Digital-Footprint-Tracker/pull/31
const DEPENDABOT_REAL_TITLE = "build(deps): bump swift from `af5d222` to `5db2c7b` in the container-dependencies group";

const DEPENDABOT_TRAILER = "Signed-off-by: dependabot[bot] <support@github.com>";
// A header of the form Dependabot writes, so that the rows below isolate the signature from the header.
const BUMP_HEADER = "build(deps): bump the g group in /frontend with 2 updates";
const LONG_NAME = "@typescript-eslint/eslint-plugin";
const BODY_REASON = /\[body-max-line-length\]/;
const HEADER_REASON = /\[header-max-length\]/;

/** The entries of .github/dependabot.yml that decide a title: the prefix, the directories and the groups. */
function dependabotEntries() {
  return read(".github/dependabot.yml")
    .split(/^ {2}- package-ecosystem: /m)
    .slice(1)
    .map((block) => {
      const lines = block.split("\n");
      const listed = lines.findIndex((line) => line === "    directories:");
      const directories = [];
      for (const line of listed === -1 ? [] : lines.slice(listed + 1)) {
        const item = /^ {6}- (\S+)$/.exec(line);
        if (item === null) {
          break;
        }
        directories.push(item[1]);
      }
      return {
        ecosystem: lines[0].trim(),
        directory: /^ {4}directory: (\S+)$/m.exec(block)?.[1],
        directories,
        prefix: /^ {6}prefix: (\S+)$/m.exec(block)?.[1],
        groups: [...(block.split(/^ {4}groups:\n/m)[1] ?? "").matchAll(/^ {6}([\w|-]+):$/gm)].map((match) => match[1]),
      };
    });
}

/** The longest title of every group of several updates that dependabot.yml can produce. */
function worstGroupTitles() {
  return dependabotEntries().flatMap(({ ecosystem, directory, directories, prefix, groups }) =>
    groups.map((group) => {
      let where = "";
      if (directories.length > 0) {
        where = " across 99 directories";
      } else if (directory !== "/") {
        where = ` in ${directory}`;
      }
      return { ecosystem, group, name: `the longest title of the ${ecosystem} group ${group}`, message: `${prefix}: bump the ${group} group${where} with 99 updates` };
    }),
  );
}

const DEPENDABOT_CASES = [
  // Real commits of Dependabot, as they are, pass.
  ...DEPENDABOT_COMMITS.map(({ name, message }) => ({ name: `Dependabot's commit of ${name}`, message })),
  // A long plain intro line passes with the bot's signature under a Dependabot header, and fails without it.
  ...DEPENDABOT_UNPREFIXED_COMMITS.flatMap(({ name, message }) => {
    const prefixed = withPrefix(message, "build(deps)");
    return [
      { name: `Dependabot's commit of ${name}`, message: prefixed },
      { name: `the same commit of ${name}, without the bot's signature`, message: prefixed.replace(`\n\n${DEPENDABOT_TRAILER}`, ""), reject: BODY_REASON },
    ];
  }),
  // A title of one update is as long as the name of the dependency.
  { name: "a real title of a group with one update, 87 characters", message: DEPENDABOT_REAL_TITLE },
  { name: "a title of one update in a group, with a directory", message: `build(deps): bump ${LONG_NAME} from 8.46.0 to 9.0.0 in /frontend in the npm-minor-patch group` },
  { name: "a title of one update, in no group", message: `build(deps): bump ${LONG_NAME} from 8.46.0 to 9.0.0 in /frontend` },
  // Several dependencies bumped together and in no group: the names are listed, and the title is as long as the list.
  // https://github.com/dev-build-deploy/sarif-it/pull/5 (92 characters)
  { name: "a real title of three dependencies bumped together", message: "build(deps-dev): bump eslint, @typescript-eslint/eslint-plugin and @typescript-eslint/parser" },
  // https://github.com/vbashian1/sokefi-site/pull/1 (99 characters): that repository's prefix is chore, which
  // this dependabot.yml never writes, so the exception does not cover it.
  { name: "a real title of four dependencies under a prefix this dependabot.yml never writes (chore)", message: "chore(deps): bump minimatch, eslint, @typescript-eslint/parser and @typescript-eslint/eslint-plugin", reject: HEADER_REASON },
  // The exception follows the prefixes of the real dependabot.yml: every entry's title of one update passes.
  ...dependabotEntries().map(({ ecosystem, prefix }) => ({
    name: `the long title of one update under the prefix of the ${ecosystem} entry`,
    message: `${prefix}: bump ${LONG_NAME} and ${LONG_NAME} in /frontend in the npm-minor-patch group`,
  })),
  { name: "two dependencies bumped together in a directory", message: "build(deps): bump @typescript-eslint/eslint-plugin and @typescript-eslint/parser in /frontend" },
  { name: "a title of one update after an audit fix", message: `build(deps): bump ${LONG_NAME} from 8.46.0 to 9.0.0 (via audit fix) in /frontend` },
  { name: "a title of one update in a group of several directories", message: "ci(deps): bump actions/upload-artifact from 4.6.2 to 5.0.0 in the actions group across 1 directory" },
  // The titles of a group of several updates, in the worst case, from the real dependabot.yml.
  ...worstGroupTitles(),
  // What a human gets: the limits stay, for anything that is not such a title or such a commit.
  { name: "a long line that holds a link (commitlint's own exception)", message: `feat(frontend): add a client\n\nsee https://example.com/${"a".repeat(120)}` },
  { name: "a long sentence under build(deps)", message: "build(deps): bump the whole world and everything else in this repository for no reason", reject: HEADER_REASON },
  { name: "a long title of one update under another type", message: `feat(deps): bump ${LONG_NAME} from 8.46.0 to 9.0.0 in /frontend in the npm-minor-patch group`, reject: HEADER_REASON },
  { name: "a long title of one update under another scope", message: `build(frontend): bump ${LONG_NAME} from 8.46.0 to 9.0.0 in /frontend in the npm-minor-patch group`, reject: HEADER_REASON },
  { name: "a long title that goes on after the new version", message: `build(deps): bump ${LONG_NAME} from 8.46.0 to 9.0.0 and a few other things`, reject: HEADER_REASON },
  { name: "a long list of names without the word and", message: `build(deps): bump ${LONG_NAME}, ${LONG_NAME}, ${LONG_NAME}`, reject: HEADER_REASON },
  { name: "a long list of names that goes on after the last one", message: `build(deps): bump ${LONG_NAME} and ${LONG_NAME} and more`, reject: HEADER_REASON },
  { name: "a long title of several updates in a group", message: `build(deps): bump the ${"g".repeat(40)} group in /frontend with 12 updates`, reject: HEADER_REASON },
  { name: "a long line under the signature of a human", message: `${BUMP_HEADER}\n\n${"b".repeat(101)}\n\nSigned-off-by: A Human <human@example.com>`, reject: BODY_REASON },
  { name: "a long line under the bot's signature, under a header that is no bump", message: `fix(frontend): add a client\n\n${"b".repeat(101)}\n\n${DEPENDABOT_TRAILER}`, reject: BODY_REASON },
  { name: "a long line under the bot's signature, under a bump of another type", message: `feat(deps): bump a group\n\n${"b".repeat(101)}\n\n${DEPENDABOT_TRAILER}`, reject: BODY_REASON },
  { name: "a long line under a signature that only starts like the bot's", message: `${BUMP_HEADER}\n\n${"b".repeat(101)}\n\n${DEPENDABOT_TRAILER} and more`, reject: BODY_REASON },
  { name: "a long line under a trailer that only ends like the bot's", message: `${BUMP_HEADER}\n\n${"b".repeat(101)}\n\nX-${DEPENDABOT_TRAILER}`, reject: BODY_REASON },
  { name: "a long line under the bot's signature, under a header with a Dependabot title", message: `${BUMP_HEADER}\n\n${"b".repeat(101)}\n\n${DEPENDABOT_TRAILER}` },
  { name: "a long line with the bot's signature right under it, no blank line between", message: `${BUMP_HEADER}\n\n${"b".repeat(101)}\n${DEPENDABOT_TRAILER}\nmore text`, reject: /\[footer-leading-blank\]/ },
];
CASES.push(...DEPENDABOT_CASES);

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

// ---- The pin of @commitlint/cli: one manifest that Dependabot reads (Q12-FU2) ------------------------------
// .github/tools/commitlint is an npm project of one dependency: package.json pins @commitlint/cli exactly and
// package-lock.json records the whole tree, with the integrity hash of every package. Dependabot (ecosystem
// npm) bumps both in one pull request. The `pr-title` and `commit-lint` jobs run `npm ci` on it, which
// installs what the lock records and fails when the two files differ, and run the binary it installs: they
// keep no copy of the release. The commit-msg hook is the one copy that must be a literal (`npx --package
// @commitlint/cli@X`: a hook cannot read a file for its release), so this guard holds it equal: a Dependabot
// bump fails here until the hook follows in the same pull request (docs/CI-CD.md says so).
//
// As in ci-gates.test.mjs, every check takes the TEXT of the files, and a table of drifts changes one copy
// at a time: each change must be refused, and for its own reason. The helpers are repeated from that file on
// purpose: the two test files are the only ones this guard may touch.
const CI = ".github/workflows/ci.yml";
const DOCS = "docs/CI-CD.md";
const CONTRIBUTING = "CONTRIBUTING.md";
const COMMITLINT_DIRECTORY = ".github/tools/commitlint";
const COMMITLINT_MANIFEST = `${COMMITLINT_DIRECTORY}/package.json`;
const COMMITLINT_LOCK = `${COMMITLINT_DIRECTORY}/package-lock.json`;
const COMMITLINT_BIN = `${COMMITLINT_DIRECTORY}/node_modules/.bin/commitlint`;

/** The text of one job of a workflow text: from its key to the next key at the same depth. */
function jobIn(workflow, id) {
  const start = workflow.search(new RegExp(`^  ${id}:\\n`, "m"));
  assert.notEqual(start, -1, `the workflow has no job ${id}`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^  [\w-]+:\n/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The rows of the pin table of docs/CI-CD.md (header `| Pin |`), as arrays of trimmed cells. */
function pinRows(docs) {
  const lines = docs.split("\n");
  const start = lines.findIndex((line) => line.startsWith("| Pin "));
  assert.notEqual(start, -1, `${DOCS} has no pin table`);
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) {
      break;
    }
    rows.push(line.split("|").slice(1, -1).map((cell) => cell.trim()));
  }
  return rows;
}

/** The commitlint releases that a text names as `@commitlint/cli@X.Y.Z`. */
function pinsIn(text) {
  return [...text.matchAll(/@commitlint\/cli@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
}

/** Every drift between the copies of the commitlint pin, as problems (none when there is none). */
function commitlintProblems({ manifest, lock, hook, ci, docs, contributing }) {
  const problems = [];
  const parsed = JSON.parse(manifest);
  const dependencies = parsed.dependencies ?? {};
  const release = /^\d+\.\d+\.\d+$/.test(dependencies["@commitlint/cli"] ?? "") ? dependencies["@commitlint/cli"] : undefined;
  const others = ["devDependencies", "optionalDependencies", "peerDependencies"].filter((key) => parsed[key] !== undefined);
  if (Object.keys(dependencies).length !== 1 || release === undefined || others.length > 0) {
    problems.push(`${COMMITLINT_MANIFEST} must pin @commitlint/cli exactly (X.Y.Z), and nothing else: found ${JSON.stringify({ dependencies, others })}`);
  }
  // The lock: the release at the root and installed, and an integrity hash for every package of the tree.
  const locked = JSON.parse(lock);
  const recordedRoot = locked.packages?.[""]?.dependencies?.["@commitlint/cli"];
  const recordedPackage = locked.packages?.["node_modules/@commitlint/cli"]?.version;
  if (recordedRoot !== release || recordedPackage !== release) {
    problems.push(`${COMMITLINT_MANIFEST} pins @commitlint/cli ${String(release)} but ${COMMITLINT_LOCK} records ${String(recordedRoot)} (root) and ${String(recordedPackage)} (installed)`);
  }
  for (const [key, entry] of Object.entries(locked.packages ?? {})) {
    if (key !== "" && !/^sha512-/.test(entry.integrity ?? "")) {
      problems.push(`${COMMITLINT_LOCK}: ${key} has no sha512 integrity`);
    }
  }
  // The hook: the one literal copy.
  const hookPins = pinsIn(hook);
  if (hookPins.length !== 1 || hookPins[0] !== release) {
    problems.push(`the commitlint hook of .pre-commit-config.yaml must pin the release of the manifest (${String(release)}), found ${JSON.stringify(hookPins)}`);
  }
  // ci.yml: no copy of the release, an install from the lock, and the binary that it installs.
  if (/@commitlint\/cli@/.test(ci)) {
    problems.push(`${CI} keeps a copy of the commitlint release: only ${COMMITLINT_DIRECTORY} names it`);
  }
  for (const id of ["pr-title", "commit-lint"]) {
    const job = jobIn(ci, id);
    const install = job.split("\n").find((line) => /\bnpm ci\b/.test(line)) ?? "";
    if (!install.includes(`--prefix ${COMMITLINT_DIRECTORY}`) || !install.includes("--ignore-scripts")) {
      problems.push(`the ${id} job must install commitlint with npm ci --prefix ${COMMITLINT_DIRECTORY} --ignore-scripts`);
    }
    if (!job.includes(COMMITLINT_BIN)) {
      problems.push(`the ${id} job must run ${COMMITLINT_BIN}, the binary that npm ci installed`);
    }
    if (/\bnpx\b/.test(job)) {
      problems.push(`the ${id} job must not fetch commitlint with npx: only the manifest names its release`);
    }
  }
  // The docs: the table says the release and where it lives, the commands follow the lock, no literal of the release.
  const row = pinRows(docs).find((cells) => cells[0].replaceAll("`", "") === "@commitlint/cli");
  if (row === undefined) {
    problems.push(`the pin table of ${DOCS} has no @commitlint/cli row`);
  } else {
    const shown = /^\d+\.\d+\.\d+/.exec(row[1])?.[0];
    if (shown !== release) {
      problems.push(`the pin table of ${DOCS} says @commitlint/cli ${String(shown)}, the manifest pins ${String(release)}`);
    }
    if (!row[2].includes(COMMITLINT_DIRECTORY)) {
      problems.push(`the pin table of ${DOCS} must say where @commitlint/cli is pinned (${COMMITLINT_DIRECTORY})`);
    }
    if (!row[3].startsWith("Dependabot")) {
      problems.push(`the pin table of ${DOCS} must say that Dependabot moves @commitlint/cli`);
    }
  }
  for (const [name, text] of [[DOCS, docs], [CONTRIBUTING, contributing]]) {
    if (/@commitlint\/cli@/.test(text)) {
      problems.push(`${name} keeps a copy of the commitlint release (@commitlint/cli@...)`);
    }
  }
  if (!docs.includes(`npm ci --prefix ${COMMITLINT_DIRECTORY}`)) {
    problems.push(`${DOCS} must give the install of commitlint from its lock (npm ci --prefix ${COMMITLINT_DIRECTORY})`);
  }
  if (!docs.includes("until the hook's copy of the release follows")) {
    problems.push(`${DOCS} must say that a Dependabot bump fails this guard until the hook's copy of the release follows`);
  }
  return problems;
}

/** The files of the commitlint pin as they are in the repository. */
function commitlintFiles() {
  for (const path of [COMMITLINT_MANIFEST, COMMITLINT_LOCK]) {
    assert.ok(existsSync(join(root, path)), `${path} is missing: the commitlint pin needs the manifest that Dependabot reads`);
  }
  return {
    manifest: read(COMMITLINT_MANIFEST),
    lock: read(COMMITLINT_LOCK),
    hook: read(".pre-commit-config.yaml"),
    ci: read(CI),
    docs: read(DOCS),
    contributing: read(CONTRIBUTING),
  };
}

/** The text with the one match of the pattern replaced; a pattern that matches twice or never fails the test. */
function replaceOnce(text, pattern, replacement) {
  const found = [...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].length;
  assert.equal(found, 1, `${String(pattern)} must match exactly once, matched ${String(found)}`);
  return text.replace(pattern, replacement);
}

/** The workflow text with one job changed by `change`, which sees the text of that job alone. */
function changeJob(workflow, id, change) {
  const job = jobIn(workflow, id);
  return workflow.replace(job, change(job));
}

/** The JSON text of a file after `edit` changed the parsed value. */
function editJson(text, edit) {
  const value = JSON.parse(text);
  edit(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

const BUMPED = "9.9.9";
// One drift per copy: the file it changes, how, and what the refusal must say.
const COMMITLINT_DRIFTS = [
  { name: "package.json moves to another release, the lock does not", file: "manifest", change: (text) => editJson(text, (value) => { value.dependencies["@commitlint/cli"] = BUMPED; }), problem: `pins @commitlint/cli ${BUMPED} but ${COMMITLINT_LOCK} records` },
  { name: "package.json loosens the pin to a range", file: "manifest", change: (text) => replaceOnce(text, /"@commitlint\/cli": "(\d)/, '"@commitlint/cli": "^$1'), problem: "must pin @commitlint/cli exactly" },
  { name: "package.json gains a second dependency", file: "manifest", change: (text) => editJson(text, (value) => { value.dependencies.yargs = "17.7.2"; }), problem: "and nothing else" },
  { name: "package.json gains a dev dependency", file: "manifest", change: (text) => editJson(text, (value) => { value.devDependencies = { yargs: "17.7.2" }; }), problem: "and nothing else" },
  { name: "the lock moves its root requirement only", file: "lock", change: (text) => editJson(text, (value) => { value.packages[""].dependencies["@commitlint/cli"] = BUMPED; }), problem: `records ${BUMPED} (root)` },
  { name: "the lock moves the installed release only", file: "lock", change: (text) => editJson(text, (value) => { value.packages["node_modules/@commitlint/cli"].version = BUMPED; }), problem: `${BUMPED} (installed)` },
  { name: "the lock holds a package without its integrity hash", file: "lock", change: (text) => editJson(text, (value) => { delete value.packages["node_modules/@commitlint/cli"].integrity; }), problem: "node_modules/@commitlint/cli has no sha512 integrity" },
  { name: "the hook pins another release", file: "hook", change: (text) => replaceOnce(text, /@commitlint\/cli@\d+\.\d+\.\d+/, `@commitlint/cli@${BUMPED}`), problem: "must pin the release of the manifest" },
  { name: "the hook stops pinning the release", file: "hook", change: (text) => replaceOnce(text, /@commitlint\/cli@\d+\.\d+\.\d+/, "@commitlint/cli"), problem: "must pin the release of the manifest" },
  { name: "ci.yml brings a literal release back into the pr-title job", file: "ci", change: (text) => changeJob(text, "pr-title", (job) => `${job}      # npx --yes --package @commitlint/cli@${BUMPED} commitlint\n`), problem: "keeps a copy of the commitlint release" },
  { name: "the commit-lint job installs without --ignore-scripts", file: "ci", change: (text) => changeJob(text, "commit-lint", (job) => replaceOnce(job, / --ignore-scripts/, "")), problem: "the commit-lint job must install commitlint with npm ci" },
  { name: "the pr-title job installs with npm install, not npm ci", file: "ci", change: (text) => changeJob(text, "pr-title", (job) => replaceOnce(job, /\bnpm ci\b/, "npm install")), problem: "the pr-title job must install commitlint with npm ci" },
  { name: "the commit-lint job installs from another folder", file: "ci", change: (text) => changeJob(text, "commit-lint", (job) => replaceOnce(job, /--prefix \.github\/tools\/commitlint/, "--prefix .github/tools")), problem: "the commit-lint job must install commitlint with npm ci" },
  { name: "the pr-title job fetches commitlint with npx", file: "ci", change: (text) => changeJob(text, "pr-title", (job) => `${job}      - run: npx --yes commitlint --version\n`), problem: "the pr-title job must not fetch commitlint with npx" },
  { name: "the pr-title job stops running the installed binary", file: "ci", change: (text) => changeJob(text, "pr-title", (job) => replaceOnce(job, /commitlint=\.github\/tools\/commitlint\/node_modules\/\.bin\/commitlint/, "commitlint=commitlint")), problem: `the pr-title job must run ${COMMITLINT_BIN}` },
  { name: "the pin table says another release", file: "docs", change: (text) => replaceOnce(text, /^(\| `@commitlint\/cli` +\| )\d+\.\d+\.\d+/m, `$1${BUMPED}`), problem: `says @commitlint/cli ${BUMPED}` },
  { name: "the pin table forgets where the pin lives", file: "docs", change: (text) => replaceOnce(text, /^(\| `@commitlint\/cli` +\|[^|]*\| )[^|]*(\|)/m, "$1the jobs and the hook $2"), problem: "must say where @commitlint/cli is pinned" },
  { name: "the pin table says commitlint is moved by hand", file: "docs", change: (text) => replaceOnce(text, /^(\| `@commitlint\/cli` +\|[^|]*\|[^|]*\| )Dependabot/m, "$1By hand"), problem: "must say that Dependabot moves @commitlint/cli" },
  { name: "docs/CI-CD.md carries a literal of the release", file: "docs", change: (text) => `${text}\nRun @commitlint/cli@21.2.4 by hand.\n`, problem: `${DOCS} keeps a copy of the commitlint release` },
  { name: "CONTRIBUTING.md carries a literal of the release", file: "contributing", change: (text) => `${text}\nRun @commitlint/cli@21.2.4 by hand.\n`, problem: `${CONTRIBUTING} keeps a copy of the commitlint release` },
  { name: "docs/CI-CD.md stops giving the install from the lock", file: "docs", change: (text) => replaceOnce(text, /npm ci --prefix \.github\/tools\/commitlint/, "npx commitlint"), problem: `${DOCS} must give the install of commitlint from its lock` },
  { name: "docs/CI-CD.md stops saying that a bump fails until the hook follows", file: "docs", change: (text) => replaceOnce(text, /until the hook's copy of the release follows/, "until somebody notices"), problem: "until the hook's copy of the release follows" },
];

test("the commitlint pin has one source of truth, and every other copy follows it", () => {
  assert.deepEqual(commitlintProblems(commitlintFiles()), []);
});

for (const { name, file, change, problem } of COMMITLINT_DRIFTS) {
  test(`a drift of the commitlint pin is refused: ${name}`, () => {
    const files = commitlintFiles();
    const changed = change(files[file]);
    assert.notEqual(changed, files[file], "the drift must change the file");
    const problems = commitlintProblems({ ...files, [file]: changed });
    assert.ok(problems.some((line) => line.includes(problem)), `expected a problem that says ${JSON.stringify(problem)}, got ${JSON.stringify(problems)}`);
  });
}

test("the table of the commitlint tests runs the release that the hook pins", () => {
  assert.match(version ?? "", /^\d+\.\d+\.\d+$/, "the pre-commit hook must pin @commitlint/cli");
  assert.deepEqual(otherHookPins, []);
});

test("the title table of docs/CI-CD.md lists the longest title of every group of dependabot.yml", () => {
  const lines = read("docs/CI-CD.md").split("\n");
  const start = lines.findIndex((line) => line.startsWith("| Ecosystem "));
  assert.notEqual(start, -1, "docs/CI-CD.md has no title table");
  const documented = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) {
      break;
    }
    const [ecosystem, group, title, characters] = line.split("|").slice(1, -1).map((cell) => cell.trim());
    documented.push({ ecosystem, group: group.replaceAll("`", ""), title: title.replaceAll("`", ""), characters: Number(characters) });
  }
  const computed = worstGroupTitles().map(({ ecosystem, group, message }) => ({ ecosystem, group, title: message, characters: message.length }));
  assert.deepEqual(documented, computed);
});
