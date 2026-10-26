// Tests of the gates that a pull request meets in the `pre-commit` job of ci.yml, as far as they are
// configuration: which size limit holds for which file (`check-added-large-files`). The hooks
// themselves are run by pre-commit; this file holds the patterns of the configuration to a table of
// real and made-up paths, so that a pattern that grows wider (or narrower) than it should fails here
// and not on the next golden that somebody adds.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { existsSync as fileExists } from "node:fs";

const root = fileURLToPath(new URL("../../", import.meta.url));

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

/**
 * The entries of one hook id in .pre-commit-config.yaml, with the `files` and `exclude` patterns and
 * the `--maxkb` limit of each (the hook may appear twice, with different files). A small reader for
 * this one file's layout: the repository has no YAML parser in its script tests.
 */
function hookEntries(id) {
  const lines = read(".pre-commit-config.yaml").split("\n");
  const entries = [];
  lines.forEach((line, index) => {
    const start = new RegExp(`^( *)- id: ${id}$`).exec(line);
    if (start === null) {
      return;
    }
    const block = [];
    for (const next of lines.slice(index + 1)) {
      const content = next.trim();
      if (content !== "" && !content.startsWith("#") && next.length - next.trimStart().length <= start[1].length) {
        break;
      }
      block.push(next);
    }
    const value = (key) => new RegExp(`^ +${key}: (.+)$`, "m").exec(block.join("\n"))?.[1];
    entries.push({
      files: value("files"),
      exclude: value("exclude"),
      maxkb: Number(/--maxkb=(\d+)/.exec(value("args") ?? "")?.[1]),
    });
  });
  return entries;
}

/** Whether pre-commit hands this path to the entry: `files` must match it and `exclude` must not. */
function applies(entry, path) {
  const wanted = entry.files === undefined || new RegExp(entry.files).test(path);
  return wanted && !(entry.exclude !== undefined && new RegExp(entry.exclude).test(path));
}

const GENERAL_LIMIT_KB = 500;
// The ceiling of a Playwright golden. Measured on the 20 tracked goldens (git ls-tree): the largest is
// 1,336,727 bytes = 1,306 KB as the hook counts (design-dark-mobile, 390 x 32,308 px, the full page of
// the /design kitchen sink); the densest is 0.195 bytes per pixel (methodology, mobile). A full page of
// 1280 x 5,000 px at that density is 1,219 KB, so the screens of the stack goldens (five states at
// 1280 x 720 and 390 x 844) stay below what is tracked today. 2,048 KB is 1.57 times the largest
// golden: room for about 18,000 px more of /design at 390 px, and a 2 x device pixel ratio (four times
// the pixels) is still refused.
const GOLDEN_CEILING_KB = 2048;

// path -> the limit that must hold for it
const LIMITS = [
  // Playwright goldens: a *-snapshots folder below frontend/e2e, at any depth, and a PNG in it.
  ["frontend/e2e/design-system.spec.ts-snapshots/design-dark-mobile-chromium-linux.png", GOLDEN_CEILING_KB],
  ["frontend/e2e/planner-visual.spec.ts-snapshots/methodology-light-desktop-chromium-linux.png", GOLDEN_CEILING_KB],
  ["frontend/e2e/stack/visual.stack.spec.ts-snapshots/results-light-desktop-stack-chromium-linux.png", GOLDEN_CEILING_KB],
  ["frontend/e2e/a.spec.ts-snapshots/named/by/the/test.png", GOLDEN_CEILING_KB],
  // Everything else keeps the limit it always had.
  ["docs/x-snapshots/a.png", GENERAL_LIMIT_KB],
  ["docs/frontend/e2e/a.spec.ts-snapshots/a.png", GENERAL_LIMIT_KB],
  ["frontend/x-snapshots/a.png", GENERAL_LIMIT_KB],
  ["frontend/e2e/a.png", GENERAL_LIMIT_KB],
  ["frontend/e2e/support/b-snapshots.png", GENERAL_LIMIT_KB],
  ["frontend/e2e/snapshots/a.png", GENERAL_LIMIT_KB],
  ["frontend/e2e/a.spec.ts-snapshots/notes.txt", GENERAL_LIMIT_KB],
  ["frontend/e2e/a.spec.ts-snapshots/a.png.txt", GENERAL_LIMIT_KB],
  ["backend/tests/fixtures/providers/routing/big.json", GENERAL_LIMIT_KB],
  ["shared/openapi.json", GENERAL_LIMIT_KB],
];

for (const [path, limit] of LIMITS) {
  test(`check-added-large-files holds ${path} to ${String(limit)} KB`, () => {
    const holding = hookEntries("check-added-large-files").filter((entry) => applies(entry, path));
    assert.equal(holding.length, 1, "exactly one entry of the hook must apply to the path");
    assert.equal(holding[0]?.maxkb, limit);
  });
}

test("the patterns of check-added-large-files mean the same in Python's re and in JavaScript", () => {
  const patterns = hookEntries("check-added-large-files").flatMap((entry) => [entry.files, entry.exclude]);
  for (const pattern of patterns.filter((candidate) => candidate !== undefined)) {
    // pre-commit searches with Python's re; inline flags and named groups are spelled differently.
    assert.doesNotMatch(pattern, /\(\?[A-Za-z]|\(\?<[A-Za-z]|\(\?P/, pattern);
  }
});

/** Every PNG in a *-snapshots folder (or below one) under frontend/e2e. */
function trackedGoldens(directory = join(root, "frontend", "e2e"), inSnapshots = false) {
  const here = inSnapshots || directory.endsWith("-snapshots");
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return trackedGoldens(path, here);
    }
    return here && entry.name.endsWith(".png") ? [path] : [];
  });
}

test("the golden ceiling covers every golden of the repository", () => {
  const goldens = trackedGoldens();
  assert.ok(goldens.length >= 20, `expected the tracked goldens, found ${String(goldens.length)}`);
  for (const golden of goldens) {
    const kb = Math.ceil(statSync(golden).size / 1024);
    assert.ok(kb <= GOLDEN_CEILING_KB, `${golden} is ${String(kb)} KB, over the ceiling of ${String(GOLDEN_CEILING_KB)} KB`);
  }
});

// The recorded provider responses are the upstream's bytes: routing/INDEX.json records the size and the
// SHA-256 of each (`stored_bytes`, `stored_sha256`), weather/README.md says `sha256sum` reproduces
// them, and ReplayCatalog.read_bytes serves them byte for byte. A final newline would change all
// three, and 39 of them have none, so end-of-file-fixer must leave them alone, and only them.
const RECORDINGS = "backend/tests/fixtures/providers";
const FIXER = hookEntries("end-of-file-fixer");

/** The files of a directory (no folders), as paths from the repository root. */
function filesOf(relativeDirectory) {
  return readdirSync(join(root, relativeDirectory), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `${relativeDirectory}/${entry.name}`);
}

const FIXER_PATHS = [
  // [path, whether end-of-file-fixer must leave it alone]
  [`${RECORDINGS}/routing/osrm-slc-den-alt3.json`, true],
  [`${RECORDINGS}/routing/valhalla-error-no-path.json`, true],
  [`${RECORDINGS}/weather/openmeteo-1001loc-post.json`, true],
  ["shared/openapi.json", true],
  // Not recordings: the index, the READMEs, other kinds of file, other folders.
  [`${RECORDINGS}/routing/INDEX.json`, false],
  [`${RECORDINGS}/routing/README.md`, false],
  [`${RECORDINGS}/weather/README.md`, false],
  [`${RECORDINGS}/weather/openmeteo-error-no-coords.txt`, false],
  [`${RECORDINGS}/geocoding/omgeo-denver.json`, false],
  [`${RECORDINGS}/routing/nested/osrm.json`, false],
  [`${RECORDINGS}/routing/osrm.json.bak`, false],
  [`${RECORDINGS}x/routing/osrm.json`, false],
  [`other/${RECORDINGS}/routing/osrm.json`, false],
  ["backend/tests/fixtures/domain/trip-denver.json", false],
  ["docs/CI-CD.md", false],
  ["frontend/package.json", false],
];

for (const [path, leftAlone] of FIXER_PATHS) {
  test(`end-of-file-fixer ${leftAlone ? "leaves" : "runs on"} ${path}`, () => {
    assert.equal(FIXER.length, 1, "the hook is listed once");
    assert.equal(!applies(FIXER[0], path), leftAlone);
  });
}

test("end-of-file-fixer leaves every recorded response of the repository alone, and nothing else there", () => {
  const recorded = ["routing", "weather"].flatMap((kind) => filesOf(`${RECORDINGS}/${kind}`));
  assert.ok(recorded.length >= 40, `expected the recorded files, found ${String(recorded.length)}`);
  for (const path of recorded) {
    const isRecording = path.endsWith(".json") && !path.endsWith("/INDEX.json");
    assert.equal(!applies(FIXER[0], path), isRecording, path);
  }
  for (const path of filesOf(`${RECORDINGS}/geocoding`)) {
    assert.ok(applies(FIXER[0], path), `${path} must keep the hook`);
  }
});

// ---- The pins that Dependabot reads (Q12-FU2) -------------------------------------------------------------
// pre-commit is pinned in ONE place, .github/tools/pre-commit/: requirements.in names the release, and
// requirements.txt is what `pip-compile --generate-hashes` makes of it, every package of the tree pinned
// and hashed. Dependabot (ecosystem pip) re-runs pip-compile on that pair when a release appears, so the
// pin moves without anybody touching another file. ci.yml installs from requirements.txt with hashes
// required and keeps no copy of the release, its cache key hashes the file, docs/CI-CD.md says the
// release and names the folder, and no document keeps a literal `pre-commit==` of its own.
//
// Every check takes the TEXT of the files, so that the same check can run over a changed copy: the table
// of drifts below changes one copy at a time, and each change must be refused, and for its own reason.
const CI = ".github/workflows/ci.yml";
const DEPENDABOT = ".github/dependabot.yml";
const DOCS = "docs/CI-CD.md";
const CONTRIBUTING = "CONTRIBUTING.md";
const PRE_COMMIT_DIRECTORY = ".github/tools/pre-commit";
const PRE_COMMIT_IN = `${PRE_COMMIT_DIRECTORY}/requirements.in`;
const PRE_COMMIT_LOCK = `${PRE_COMMIT_DIRECTORY}/requirements.txt`;

/** A string as a regular expression that matches it and nothing else. */
function literal(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

/**
 * The packages of a pip-compile file made with --generate-hashes (name, version, number of sha256 hashes),
 * and every line that is none of that: a comment and a blank line aside, such a file holds nothing else.
 */
function lockedPackages(lock) {
  const entries = [];
  const stray = [];
  lock.split("\n").forEach((line, index) => {
    const entry = /^([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)(?: ;[^\\\n]*?)?(?: \\)?$/.exec(line);
    if (entry !== null) {
      entries.push({ name: entry[1], version: entry[2], hashes: 0 });
    } else if (/^ {4}--hash=sha256:[0-9a-f]{64}(?: \\)?$/.test(line) && entries.length > 0) {
      entries.at(-1).hashes += 1;
    } else if (line.trim() !== "" && !/^\s*#/.test(line)) {
      stray.push(`line ${String(index + 1)}: ${line}`);
    }
  });
  return { entries, stray };
}

/** What dependabot.yml must say for one directory of a tool manifest, as problems (none when it is right). */
function dependabotEntryProblems(dependabot, ecosystem, directory) {
  const block = dependabot
    .split(/^ {2}- package-ecosystem: /m)
    .slice(1)
    .find((candidate) => candidate.startsWith(`${ecosystem}\n`) && candidate.includes(`\n    directory: ${directory}\n`));
  if (block === undefined) {
    return [`dependabot.yml has no ${ecosystem} entry for ${directory}`];
  }
  const problems = [];
  if (!/^ {6}interval: weekly$/m.test(block)) {
    problems.push(`the ${ecosystem} entry for ${directory} must run weekly`);
  }
  if (!/^ {6}prefix: \S+$/m.test(block)) {
    problems.push(`the ${ecosystem} entry for ${directory} must set a commit-message prefix`);
  }
  return problems;
}

/** Every drift between the copies of the pre-commit pin, as problems (none when there is none). */
function preCommitProblems({ requirementsIn, lock, ci, docs, contributing, dependabot }) {
  const problems = [];
  const requirements = requirementsIn.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  const release = /^pre-commit==(\d+\.\d+\.\d+)$/.exec(requirements[0] ?? "")?.[1];
  if (requirements.length !== 1 || release === undefined) {
    problems.push(`${PRE_COMMIT_IN} must hold one requirement, an exact pin of pre-commit (pre-commit==X.Y.Z), found ${JSON.stringify(requirements)}`);
  }
  // The lock: the tree pinned and hashed, and the header that tells Dependabot how to remake it.
  const { entries, stray } = lockedPackages(lock);
  for (const line of stray) {
    problems.push(`${PRE_COMMIT_LOCK} holds a line that is no pinned, hashed requirement: ${line}`);
  }
  const locked = entries.filter((entry) => entry.name === "pre-commit").map((entry) => entry.version);
  if (locked.length !== 1 || locked[0] !== release) {
    problems.push(`${PRE_COMMIT_IN} pins pre-commit ${String(release)} but ${PRE_COMMIT_LOCK} locks ${JSON.stringify(locked)}`);
  }
  for (const entry of entries.filter((candidate) => candidate.hashes === 0)) {
    problems.push(`${PRE_COMMIT_LOCK}: ${entry.name} has no sha256 hash`);
  }
  const header = /^# This file is autogenerated by pip-compile with Python \d+\.\d+$/m.test(lock) && /^#\s+pip-compile\b[^\n]*--generate-hashes[^\n]*requirements\.in$/m.test(lock);
  if (!header) {
    problems.push(`${PRE_COMMIT_LOCK} must be the output of pip-compile --generate-hashes on requirements.in, with its header: Dependabot remakes the file with the options it finds there`);
  }
  // ci.yml: no copy of the release, an install from the lock with hashes required, a cache key that follows the lock.
  if (/PRE_COMMIT_VERSION|pre-commit==/.test(ci)) {
    problems.push(`${CI} keeps a copy of the pre-commit release: only ${PRE_COMMIT_DIRECTORY} names it`);
  }
  const job = jobIn(ci, "pre-commit");
  const installs = job.split("\n").filter((line) => /\buv pip install\b/.test(line));
  if (!installs.some((line) => line.includes("--require-hashes") && line.includes(`-r ${PRE_COMMIT_LOCK}`))) {
    problems.push(`the pre-commit job must install from ${PRE_COMMIT_LOCK} with --require-hashes`);
  }
  if (!new RegExp(`^\\s+key: .*hashFiles\\([^)]*${literal(PRE_COMMIT_LOCK)}[^)]*\\)`, "m").test(job)) {
    problems.push(`the cache key of the pre-commit job must hash ${PRE_COMMIT_LOCK}`);
  }
  if (/\buvx\b/.test(job)) {
    problems.push("the pre-commit job must run the pre-commit that it installed from the manifest, not fetch another with uvx");
  }
  // The docs: the table says the release and where it lives, and no document keeps a literal of it.
  const row = pinRows(docs).find((cells) => cells[0] === "pre-commit");
  if (row === undefined) {
    problems.push(`the pin table of ${DOCS} has no pre-commit row`);
  } else {
    const shown = /^\d+\.\d+\.\d+/.exec(row[1])?.[0];
    if (shown !== release) {
      problems.push(`the pin table of ${DOCS} says pre-commit ${String(shown)}, the manifest pins ${String(release)}`);
    }
    if (!row[2].includes(PRE_COMMIT_DIRECTORY)) {
      problems.push(`the pin table of ${DOCS} must say where pre-commit is pinned (${PRE_COMMIT_DIRECTORY})`);
    }
    if (!row[3].startsWith("Dependabot")) {
      problems.push(`the pin table of ${DOCS} must say that Dependabot moves pre-commit`);
    }
  }
  for (const [name, text] of [[DOCS, docs], [CONTRIBUTING, contributing]]) {
    if (/pre-commit==/.test(text)) {
      problems.push(`${name} keeps a copy of the pre-commit release (pre-commit==...)`);
    }
    if (!new RegExp(`uv pip install [^\\n]*--require-hashes [^\\n]*-r ${literal(PRE_COMMIT_LOCK)}`).test(text)) {
      problems.push(`${name} must give the install of pre-commit from the manifest (uv pip install ... --require-hashes -r ${PRE_COMMIT_LOCK})`);
    }
  }
  problems.push(...dependabotEntryProblems(dependabot, "pip", `/${PRE_COMMIT_DIRECTORY}`));
  return problems;
}

/** The files of the pre-commit pin as they are in the repository. */
function preCommitFiles() {
  for (const path of [PRE_COMMIT_IN, PRE_COMMIT_LOCK]) {
    assert.ok(fileExists(join(root, path)), `${path} is missing: the pre-commit pin needs the manifest that Dependabot reads`);
  }
  return {
    requirementsIn: read(PRE_COMMIT_IN),
    lock: read(PRE_COMMIT_LOCK),
    ci: read(CI),
    docs: read(DOCS),
    contributing: read(CONTRIBUTING),
    dependabot: read(DEPENDABOT),
  };
}

/** The text with the one match of the pattern replaced; a pattern that matches twice or never fails the test. */
function replaceOnce(text, pattern, replacement) {
  const found = [...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].length;
  assert.equal(found, 1, `${String(pattern)} must match exactly once, matched ${String(found)}`);
  return text.replace(pattern, replacement);
}

const BUMPED = "9.9.9";
// One drift per copy: the file it changes, how, and what the refusal must say.
const PRE_COMMIT_DRIFTS = [
  { name: "requirements.in moves to another release, the lock does not", file: "requirementsIn", change: (text) => replaceOnce(text, /^pre-commit==\d+\.\d+\.\d+$/m, `pre-commit==${BUMPED}`), problem: `pins pre-commit ${BUMPED} but` },
  { name: "requirements.in loosens the pin to a range", file: "requirementsIn", change: (text) => replaceOnce(text, /^pre-commit==/m, "pre-commit>="), problem: "must hold one requirement" },
  { name: "requirements.in gains a second requirement", file: "requirementsIn", change: (text) => `${text}virtualenv==21.0.0\n`, problem: "must hold one requirement" },
  { name: "the lock moves to another release, requirements.in does not", file: "lock", change: (text) => replaceOnce(text, /^pre-commit==\d+\.\d+\.\d+/m, `pre-commit==${BUMPED}`), problem: "but .github/tools/pre-commit/requirements.txt locks" },
  { name: "the lock drops the hashes of one package", file: "lock", change: (text) => replaceOnce(text, /^(nodeenv==\S+) \\\n(?: {4}--hash=sha256:[0-9a-f]{64}(?: \\)?\n)+/m, "$1\n"), problem: "nodeenv has no sha256 hash" },
  { name: "the lock gains a requirement that is neither pinned nor hashed", file: "lock", change: (text) => `${text}-e .\n`, problem: "holds a line that is no pinned, hashed requirement" },
  { name: "the lock is made by another tool", file: "lock", change: (text) => replaceOnce(text, /autogenerated by pip-compile/, "autogenerated by uv"), problem: "must be the output of pip-compile --generate-hashes" },
  { name: "the lock is made without hashes", file: "lock", change: (text) => replaceOnce(text, /--generate-hashes /, ""), problem: "must be the output of pip-compile --generate-hashes" },
  { name: "ci.yml brings back an env line with the release", file: "ci", change: (text) => replaceOnce(text, /^( {4}name: Pre-commit hooks \(changed files\)\n)/m, "$1    env:\n      PRE_COMMIT_VERSION: 4.7.0\n"), problem: "keeps a copy of the pre-commit release" },
  { name: "ci.yml runs a pinned pre-commit of its own through uvx", file: "ci", change: (text) => replaceOnce(text, /^( +run: )pre-commit run --from-ref/m, '$1uvx --from "pre-commit==4.7.0" pre-commit run --from-ref'), problem: "keeps a copy of the pre-commit release" },
  { name: "ci.yml runs an unpinned pre-commit through uvx", file: "ci", change: (text) => replaceOnce(text, /^( +run: )pre-commit run --from-ref/m, "$1uvx pre-commit run --from-ref"), problem: "not fetch another with uvx" },
  { name: "ci.yml installs without requiring hashes", file: "ci", change: (text) => replaceOnce(text, / --require-hashes/, ""), problem: "with --require-hashes" },
  { name: "ci.yml installs from another file", file: "ci", change: (text) => replaceOnce(text, /-r \.github\/tools\/pre-commit\/requirements\.txt/, "-r .github/tools/pre-commit/requirements.in"), problem: "with --require-hashes" },
  { name: "the cache key stops hashing the lock", file: "ci", change: (text) => replaceOnce(text, /hashFiles\('\.github\/tools\/pre-commit\/requirements\.txt', /, "hashFiles("), problem: "cache key of the pre-commit job must hash" },
  { name: "the pin table says another release", file: "docs", change: (text) => replaceOnce(text, /^(\| pre-commit +\| )\d+\.\d+\.\d+/m, `$1${BUMPED}`), problem: `says pre-commit ${BUMPED}` },
  { name: "the pin table forgets where the pin lives", file: "docs", change: (text) => replaceOnce(text, /^(\| pre-commit +\| \d+\.\d+\.\d+[^|]*\| )[^|]*(\|)/m, "$1the pre-commit job $2"), problem: "must say where pre-commit is pinned" },
  { name: "the pin table says pre-commit is moved by hand", file: "docs", change: (text) => replaceOnce(text, /^(\| pre-commit +\|[^|]*\|[^|]*\| )Dependabot/m, "$1By hand"), problem: "must say that Dependabot moves pre-commit" },
  { name: "docs/CI-CD.md carries a literal of the release", file: "docs", change: (text) => `${text}\nRun pre-commit==4.7.0 by hand.\n`, problem: `${DOCS} keeps a copy of the pre-commit release` },
  { name: "CONTRIBUTING.md carries a literal of the release", file: "contributing", change: (text) => `${text}\nRun pre-commit==4.7.0 by hand.\n`, problem: `${CONTRIBUTING} keeps a copy of the pre-commit release` },
  { name: "docs/CI-CD.md installs without requiring hashes", file: "docs", change: (text) => replaceOnce(text, /(uv pip install [^\n]*) --require-hashes/, "$1"), problem: `${DOCS} must give the install of pre-commit` },
  { name: "CONTRIBUTING.md installs without requiring hashes", file: "contributing", change: (text) => replaceOnce(text, /(uv pip install [^\n]*) --require-hashes/, "$1"), problem: `${CONTRIBUTING} must give the install of pre-commit` },
  { name: "dependabot.yml looks at another folder for pip", file: "dependabot", change: (text) => replaceOnce(text, /directory: \/\.github\/tools\/pre-commit/, "directory: /.github/tools"), problem: "has no pip entry for /.github/tools/pre-commit" },
  { name: "dependabot.yml runs the pip entry daily", file: "dependabot", change: (text) => replaceOnce(text, /(directory: \/\.github\/tools\/pre-commit\n {4}schedule:\n {6}interval: )weekly/, "$1daily"), problem: "must run weekly" },
  { name: "dependabot.yml gives the pip entry no commit prefix", file: "dependabot", change: (text) => replaceOnce(text, /(directory: \/\.github\/tools\/pre-commit\n(?:(?! {2}- package-ecosystem).*\n)*? {6}prefix: )\S+\n/, "$1\n"), problem: "must set a commit-message prefix" },
];

test("the pre-commit pin has one source of truth, and every other copy follows it", () => {
  assert.deepEqual(preCommitProblems(preCommitFiles()), []);
});

for (const { name, file, change, problem } of PRE_COMMIT_DRIFTS) {
  test(`a drift of the pre-commit pin is refused: ${name}`, () => {
    const files = preCommitFiles();
    const changed = change(files[file]);
    assert.notEqual(changed, files[file], "the drift must change the file");
    const problems = preCommitProblems({ ...files, [file]: changed });
    assert.ok(problems.some((line) => line.includes(problem)), `expected a problem that says ${JSON.stringify(problem)}, got ${JSON.stringify(problems)}`);
  });
}

const COMMITLINT_DIRECTORY = "/.github/tools/commitlint";
const NPM_ENTRY_DRIFTS = [
  { name: "looks at another folder for npm", change: (text) => replaceOnce(text, /directory: \/\.github\/tools\/commitlint/, "directory: /.github/tools"), problem: "has no npm entry for /.github/tools/commitlint" },
  { name: "runs the npm entry daily", change: (text) => replaceOnce(text, /(directory: \/\.github\/tools\/commitlint\n {4}schedule:\n {6}interval: )weekly/, "$1daily"), problem: "must run weekly" },
  { name: "gives the npm entry no commit prefix", change: (text) => replaceOnce(text, /(directory: \/\.github\/tools\/commitlint\n(?:(?! {2}- package-ecosystem).*\n)*? {6}prefix: )\S+\n/, "$1\n"), problem: "must set a commit-message prefix" },
  { name: "drops the npm entry", change: (text) => replaceOnce(text, /\n {2}- package-ecosystem: npm\n {4}directory: \/\.github\/tools\/commitlint\n/, "\n  - package-ecosystem: npm\n    directory: /elsewhere\n"), problem: "has no npm entry for /.github/tools/commitlint" },
];

test("dependabot.yml reads the commitlint manifest: an npm entry for its folder, weekly, with a commit prefix", () => {
  assert.deepEqual(dependabotEntryProblems(read(DEPENDABOT), "npm", COMMITLINT_DIRECTORY), []);
  assert.ok(fileExists(join(root, `${COMMITLINT_DIRECTORY.slice(1)}/package.json`)), "the folder of the entry must hold package.json");
  assert.ok(fileExists(join(root, `${COMMITLINT_DIRECTORY.slice(1)}/package-lock.json`)), "the folder of the entry must hold package-lock.json");
});

for (const { name, change, problem } of NPM_ENTRY_DRIFTS) {
  test(`a drift of the npm entry is refused: dependabot.yml ${name}`, () => {
    const dependabot = read(DEPENDABOT);
    const changed = change(dependabot);
    assert.notEqual(changed, dependabot, "the drift must change the file");
    const problems = dependabotEntryProblems(changed, "npm", COMMITLINT_DIRECTORY);
    assert.ok(problems.some((line) => line.includes(problem)), `expected a problem that says ${JSON.stringify(problem)}, got ${JSON.stringify(problems)}`);
  });
}

test("the pin table of docs/CI-CD.md names the gitleaks release that CI pins", () => {
  const gitleaks = pinRows(read(DOCS)).find((row) => row[0].startsWith("gitleaks"));
  const ciGitleaks = /GITLEAKS_VERSION: (\S+)/.exec(jobIn(read(CI), "pre-commit"))?.[1];
  assert.equal(/^\d+\.\d+\.\d+/.exec(gitleaks?.[1] ?? "")?.[0], ciGitleaks);
});

test("every pin in the table of docs/CI-CD.md is moved by Dependabot or names the test that enforces it", () => {
  const rows = pinRows(read(DOCS));
  assert.ok(rows.length >= 4, "the pin table lost rows");
  for (const row of rows) {
    const named = [...row[3].matchAll(/scripts\/tests\/[\w.-]+\.test\.mjs/g)].map((match) => match[0]);
    for (const file of named) {
      assert.ok(fileExists(join(root, file)), `the pin "${row[0]}" names ${file}, which does not exist`);
    }
    assert.ok(named.length > 0 || row[3].startsWith("Dependabot"), `the pin "${row[0]}" must name a test under scripts/tests that exists, or be moved by Dependabot: ${row[3]}`);
  }
});

test("Dependabot reads the folder of .pre-commit-config.yaml, so a hook revision bump reaches the pin guards", () => {
  assert.ok(fileExists(join(root, ".pre-commit-config.yaml")));
  assert.match(read(DEPENDABOT), /^ {2}- package-ecosystem: pre-commit\n {4}directory: \/\n/m);
});
