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
