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

// ---- The pins that nothing else reads (F5) ---------------------------------------------------------
// ci.yml pins the tools it runs in env lines, which Dependabot does not read. gitleaks has an update path
// through the revision of its hook (gitleaks-pin.test.mjs holds the CI pins to it). pre-commit has none
// that this repository owns, so these tests hold what can be held: one pin, read by every user of it, named
// by the docs, and every pin in the docs names the gate that enforces its update.
const CI = ".github/workflows/ci.yml";

/** The text of one job of a workflow: from its key to the next key at the same depth. */
function jobText(workflow, id) {
  const text = read(workflow);
  const start = text.search(new RegExp(`^  ${id}:\\n`, "m"));
  assert.notEqual(start, -1, `${workflow} has no job ${id}`);
  const rest = text.slice(start + 1);
  const next = rest.search(/^  [\w-]+:\n/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The pre-commit release that CI pins, and every place that carries a literal version of it. */
function preCommitPins() {
  const job = jobText(CI, "pre-commit");
  return {
    job,
    env: [...job.matchAll(/^\s+PRE_COMMIT_VERSION: (\S+)\s*$/gm)].map((match) => match[1]),
    literals: [...read(CI).matchAll(/pre-commit==([^\s"]+)/g)].map((match) => match[1]),
  };
}

/** The rows of the pin table of docs/CI-CD.md (header `| Pin |`), as arrays of trimmed cells. */
function pinTable() {
  const lines = read("docs/CI-CD.md").split("\n");
  const start = lines.findIndex((line) => line.startsWith("| Pin "));
  assert.notEqual(start, -1, "docs/CI-CD.md has no pin table");
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) {
      break;
    }
    rows.push(line.split("|").slice(1, -1).map((cell) => cell.trim()));
  }
  return rows;
}

test("the pre-commit job pins pre-commit once, and its cache key and run step read that pin", () => {
  const { job, env, literals } = preCommitPins();
  assert.equal(env.length, 1, `${CI} must pin PRE_COMMIT_VERSION once in the pre-commit job, found ${String(env.length)}`);
  assert.match(env[0] ?? "", /^\d+\.\d+\.\d+$/);
  assert.ok(job.includes("${{ env.PRE_COMMIT_VERSION }}"), "the cache key must name the pin");
  assert.deepEqual(literals, ["${PRE_COMMIT_VERSION}"], "the run step is the only user of the release, and it reads the pin");
});

test("the pin table of docs/CI-CD.md names the releases that CI pins", () => {
  const rows = pinTable();
  const preCommit = rows.find((row) => row[0] === "pre-commit");
  assert.equal(/^\d+\.\d+\.\d+/.exec(preCommit?.[1] ?? "")?.[0], preCommitPins().env[0]);
  const gitleaks = rows.find((row) => row[0].startsWith("gitleaks"));
  const ciGitleaks = /GITLEAKS_VERSION: (\S+)/.exec(jobText(CI, "pre-commit"))?.[1];
  assert.equal(/^\d+\.\d+\.\d+/.exec(gitleaks?.[1] ?? "")?.[0], ciGitleaks);
});

test("every pin in the table of docs/CI-CD.md names the gate that enforces its update", () => {
  const rows = pinTable();
  assert.ok(rows.length >= 4, "the pin table lost rows");
  for (const row of rows) {
    const named = [...row[3].matchAll(/scripts\/tests\/[\w.-]+\.test\.mjs/g)].map((match) => match[0]);
    const enforced = named.length > 0 && named.every((file) => fileExists(join(root, file)));
    // A hook revision is moved by Dependabot itself, and the hook run is its gate.
    assert.ok(enforced || row[3].startsWith("Dependabot"), `the pin "${row[0]}" must name a test under scripts/tests that exists, or be moved by Dependabot: ${row[3]}`);
  }
});

test("Dependabot reads the folder of .pre-commit-config.yaml, so a hook revision bump reaches the pin guards", () => {
  assert.ok(fileExists(join(root, ".pre-commit-config.yaml")));
  assert.match(read(".github/dependabot.yml"), /^ {2}- package-ecosystem: pre-commit\n {4}directory: \/\n/m);
});
