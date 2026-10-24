import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  DESIGN_JS_BUDGET_BYTES,
  INITIAL_JS_BUDGET_BYTES,
  INITIAL_JS_FILE_BUDGETS,
  INPUT_JS_BUDGET_BYTES,
  MEASURED_ON_NODE,
  capProblem,
  describeInitialJs,
  fileBudgetProblem,
  isMapLibreChunk,
  measureScript,
  summarise,
  summaryLine,
} from "./initial-js.ts";
import type { InitialJs, ScriptFile } from "./initial-js.ts";

/** One script a pretend page downloaded; MapLibre's chunks are marked as excluded. */
function script(path: string, gzipBytes: number, rawBytes = gzipBytes * 3): ScriptFile {
  return { path, rawBytes, gzipBytes, excluded: isMapLibreChunk(path) };
}

describe("the N1 budget", () => {
  it("is 180 kB, decimal, as REQUIREMENTS.md writes it", () => {
    expect(INITIAL_JS_BUDGET_BYTES).toBe(180_000);
  });
});

// D-49 ruled that what the planner downloads after one input never rises above this many bytes.
// The cap goes down whenever the total does: lower this number in the same change that lowers the
// cap, so a later change cannot spend the room a lower cap gave up. P1 (D-48) lowered it from
// 343,169 to 332,625 (D-51: only itemized rows in the three closed categories raise it).
const D49_CEILING_BYTES = 332_625;

describe("the planner's cap after one input (D-46 3.5(c), D-49)", () => {
  it("never rises above the ceiling D-49 set", () => {
    expect(INPUT_JS_BUDGET_BYTES).toBeLessThanOrEqual(D49_CEILING_BYTES);
  });
});

/** The Node that CI measures on, written the way `process.version` writes it. */
const PINNED_NODE = `v${MEASURED_ON_NODE}`;

describe("capProblem", () => {
  it("accepts a total that is exactly the cap", () => {
    expect(capProblem(343_169, 343_169, PINNED_NODE)).toBeNull();
  });

  it("refuses a total over the cap and says that the cap does not rise", () => {
    const problem = capProblem(343_170, 343_169, PINNED_NODE);

    expect(problem).toContain("1 B over the cap");
    expect(problem).toContain("D-51");
  });

  it("refuses a total under the cap and says what to lower the cap to", () => {
    const problem = capProblem(343_100, 343_169, PINNED_NODE);

    expect(problem).toContain("69 B under the cap");
    expect(problem).toContain("lower INPUT_JS_BUDGET_BYTES to 343,100");
  });

  it("holds the planner's cap when none is given", () => {
    expect(capProblem(INPUT_JS_BUDGET_BYTES, undefined, PINNED_NODE)).toBeNull();
    expect(capProblem(INPUT_JS_BUDGET_BYTES + 1, undefined, PINNED_NODE)).not.toBeNull();
  });
});

// Q3 (D-51 item 5): the cap is an exact number, and a gzipped length belongs to the zlib build that
// gzips it; the zlib build inside Node can change from one release to the next. So only the Node
// that CI installs, the one the cap was measured on, can judge it. Any other Node must say that it
// cannot, and above all must not name a number to lower the cap to.
describe("capProblem on a Node that is not the pinned one (Q3, D-51 item 5)", () => {
  /** The pinned release's next patch, `v24.21.1` for `v24.21.0`: the same line, another release. */
  const NEXT_PATCH = PINNED_NODE.replace(/\d+$/u, (patch) => String(Number(patch) + 1));
  /** The next major, `v25.0.0` for `v24.21.0`. */
  const NEXT_MAJOR = PINNED_NODE.replace(
    /^v(\d+)\..*$/u,
    (_, major: string) => `v${String(Number(major) + 1)}.0.0`,
  );

  it.each([NEXT_PATCH, NEXT_MAJOR])(
    "says that it cannot judge on %s, and which Node can",
    (node) => {
      const problem = capProblem(INPUT_JS_BUDGET_BYTES, INPUT_JS_BUDGET_BYTES, node);

      expect(problem).toContain(`cannot judge exact equality on Node ${node}; CI is the authority`);
      expect(problem).toContain(`Node ${MEASURED_ON_NODE}`);
      expect(problem).toContain("frontend/.nvmrc");
    },
  );

  it.each([
    ["over the cap", 343_170],
    ["exactly the cap", 343_169],
    ["under the cap", 343_100],
  ])("names no number to set the cap to when the total is %s", (_what, total) => {
    const problem = capProblem(total, 343_169, NEXT_PATCH);

    expect(problem).toContain("cannot judge");
    expect(problem).not.toContain("lower INPUT_JS_BUDGET_BYTES");
    expect(problem).not.toContain("under the cap");
    expect(problem).not.toContain("over the cap");
    expect(problem).not.toContain(total.toLocaleString("en-US"));
  });

  it("judges on the Node that runs it when none is given", () => {
    expect(capProblem(INPUT_JS_BUDGET_BYTES)).toBe(
      capProblem(INPUT_JS_BUDGET_BYTES, INPUT_JS_BUDGET_BYTES, process.version),
    );
  });
});

/** The repository root, three folders up from this file. */
const REPOSITORY = resolve(import.meta.dirname, "../../..");

/** A file of the repository, by its path from the root. */
function readRepositoryFile(path: string): string {
  return readFileSync(join(REPOSITORY, path), "utf8");
}

/** Every workflow and every local action: the files in which a job can install Node. */
function ciFiles(): string[] {
  const workflows = readdirSync(join(REPOSITORY, ".github", "workflows"))
    .filter((name) => name.endsWith(".yml"))
    .map((name) => `.github/workflows/${name}`);
  const actions = readdirSync(join(REPOSITORY, ".github", "actions")).map(
    (name) => `.github/actions/${name}/action.yml`,
  );
  return [...workflows, ...actions];
}

// Q3: the pin is one number written in three places. `.nvmrc` holds it, `engines` repeats it so
// that pnpm warns on any other Node, and the jobs read it from `.nvmrc` instead of naming a version
// of their own. A job that names its own version would measure the budgets on a Node nobody pinned.
describe("the Node that measures the budgets (Q3, D-51 item 5)", () => {
  it("is one exact release, not a range and not a major", () => {
    expect(MEASURED_ON_NODE).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it("is what `engines` in package.json asks for", () => {
    const manifest = JSON.parse(readRepositoryFile("frontend/package.json")) as {
      engines: { node: string };
    };

    expect(manifest.engines.node).toBe(MEASURED_ON_NODE);
  });

  it("is installed by every job that installs Node, read from frontend/.nvmrc", () => {
    const installers = ciFiles().filter((path) =>
      readRepositoryFile(path).includes("uses: actions/setup-node@"),
    );

    expect(installers).toEqual([
      ".github/workflows/ci.yml",
      ".github/actions/setup-frontend/action.yml",
    ]);
    for (const path of installers) {
      const text = readRepositoryFile(path);
      const installs = text.match(/uses: actions\/setup-node@/gu) ?? [];
      const reads = text.match(/^\s+node-version-file: frontend\/\.nvmrc$/gmu) ?? [];
      expect(reads, path).toHaveLength(installs.length);
    }
  });

  it("is not overridden by a version that a workflow or an action names itself", () => {
    for (const path of ciFiles()) {
      expect(readRepositoryFile(path), path).not.toMatch(/^\s+node-version:/mu);
    }
  });
});

// P1 (D-48) measured these on e560de5 with the style guide's 40 demos behind ONE lazy chunk: the
// script files a first visit requests when the demos do not cut the shared code. A budget never
// rises above them. A page that needs more files than that has its shared code cut along the
// demos again (the D-35 chunk tax), or has grown a chunk of its own and has to say why.
const NO_TAX_FILES = { planner: 22, methodology: 26, fallback: 18 } as const;

describe("the budget of script files (P1, D-48)", () => {
  it("never rises above what the same pages request without the D-35 chunk tax", () => {
    expect(INITIAL_JS_FILE_BUDGETS.planner).toBeLessThanOrEqual(NO_TAX_FILES.planner);
    expect(INITIAL_JS_FILE_BUDGETS.methodology).toBeLessThanOrEqual(NO_TAX_FILES.methodology);
    expect(INITIAL_JS_FILE_BUDGETS.fallback).toBeLessThanOrEqual(NO_TAX_FILES.fallback);
  });
});

// R3-12: what CI measured for the style guide with `measureInitialJs` (chromium, gzip level 6, a
// first visit with no input, MapLibre's chunks aside). The source is the probe run 40092296424, job
// 120867275385, on 41a32a4's app code and Node 24.21.0: three repeats, the same bytes in each. A
// budget is that number rounded up to the next 1,000 B (headroom under 5%), and this test holds the
// rounding: a budget cannot grow past the page it holds without a new measurement written down here.
const DESIGN_MEASURED_BYTES = { section: 178_270, all: 343_111 } as const;

describe("the style guide's budget (R3-12)", () => {
  it.each([
    { key: "section", page: "/design?section=TextField" },
    { key: "all", page: "/design" },
  ] as const)("for $page is what CI measured, rounded up to the next 1,000 B", ({ key }) => {
    const roundedUp = Math.ceil(DESIGN_MEASURED_BYTES[key] / 1_000) * 1_000;

    expect(DESIGN_JS_BUDGET_BYTES[key]).toBe(roundedUp);
  });
});

describe("fileBudgetProblem", () => {
  /** A page that requests `count` script files of 1 kB, and whatever else `extra` adds. */
  function pageOf(count: number, extra: readonly ScriptFile[] = []): InitialJs {
    const files = Array.from({ length: count }, (_, index) =>
      script(`/assets/chunk-${String(index)}.js`, 1_000),
    );
    return summarise([...files, ...extra]);
  }

  it("accepts a page that requests exactly as many files as the budget", () => {
    expect(fileBudgetProblem("/", pageOf(22), 22)).toBeNull();
  });

  it("accepts a page that requests fewer files than the budget", () => {
    expect(fileBudgetProblem("/", pageOf(19), 22)).toBeNull();
  });

  it("refuses a page over the budget, says by how many files, and says where to look", () => {
    const problem = fileBudgetProblem("/methodology", pageOf(46), 26);

    expect(problem).toContain("/methodology requests 46 script files");
    expect(problem).toContain("20 over the budget of 26");
    expect(problem).toContain("demoBlindChunks");
  });

  it("leaves MapLibre's chunks out of the count, as it leaves them out of the bytes", () => {
    const measured = pageOf(22, [script("/assets/MapView-b.js", 250_000)]);

    expect(fileBudgetProblem("/", measured, 22)).toBeNull();
  });
});

describe("isMapLibreChunk", () => {
  it.each([
    "/assets/MapView-D3BoeF-v.js",
    "/assets/maplibre-gl-worker-BrB25tGK.mjs",
    "/assets/MapView-ab_cd.js",
  ])("leaves %s out of the budget", (path) => {
    expect(isMapLibreChunk(path)).toBe(true);
  });

  it.each([
    "/assets/home-bjkro1fK.js",
    "/assets/design-map-jCtnscza.js",
    "/assets/MapViewport-abc123.js",
    "/assets/TimeField-zpW0W4oU.js",
    "/MapView-D3BoeF-v.js",
  ])("counts %s", (path) => {
    expect(isMapLibreChunk(path)).toBe(false);
  });
});

describe("measureScript", () => {
  it("reports the raw size and the gzip size at zlib's default level", () => {
    const body = Buffer.from("export const answer = 42;\n".repeat(400));

    const file = measureScript("/assets/home-abc.js", body);

    expect(file).toEqual({
      path: "/assets/home-abc.js",
      rawBytes: body.length,
      gzipBytes: gzipSync(body, { level: 6 }).length,
      excluded: false,
    });
    expect(file.gzipBytes).toBeLessThan(file.rawBytes / 10);
  });

  it("flags a MapLibre chunk as excluded", () => {
    expect(measureScript("/assets/MapView-D3BoeF-v.js", Buffer.from("x")).excluded).toBe(true);
  });
});

describe("summarise", () => {
  it("adds up every file that counts and sets the excluded ones apart", () => {
    const summary = summarise([
      script("/assets/entry.client-a.js", 60_000, 200_000),
      script("/assets/MapView-b.js", 300_000, 1_000_000),
      script("/assets/home-c.js", 15_000, 50_000),
    ]);

    expect(summary.gzipBytes).toBe(75_000);
    expect(summary.rawBytes).toBe(250_000);
    expect(summary.excludedGzipBytes).toBe(300_000);
  });

  it("lists the biggest file first, so a report starts with what to fix", () => {
    const summary = summarise([
      script("/assets/small-a.js", 1_000),
      script("/assets/big-b.js", 90_000),
      script("/assets/mid-c.js", 20_000),
    ]);

    expect(summary.files.map((file) => file.path)).toEqual([
      "/assets/big-b.js",
      "/assets/mid-c.js",
      "/assets/small-a.js",
    ]);
  });

  it("measures nothing for a page that loads no script", () => {
    expect(summarise([])).toEqual({
      files: [],
      fileCount: 0,
      rawBytes: 0,
      gzipBytes: 0,
      excludedGzipBytes: 0,
    });
  });

  it("counts the files that count, and leaves MapLibre's out as it leaves out its bytes", () => {
    const summary = summarise([
      script("/assets/entry.client-a.js", 1_000),
      script("/assets/MapView-b.js", 1_000),
      script("/assets/maplibre-gl-worker-c.mjs", 1_000),
      script("/assets/home-d.js", 1_000),
    ]);

    expect(summary.fileCount).toBe(2);
    expect(summary.files).toHaveLength(4);
  });
});

describe("summaryLine", () => {
  it("names how many files the page requests next to the bytes", () => {
    const line = summaryLine(
      "/",
      summarise([
        script("/assets/a.js", 10_000),
        script("/assets/b.js", 5_000),
        script("/assets/MapView-c.js", 9_000),
      ]),
    );

    expect(line).toContain("/ downloads 15,000 B of gzipped JavaScript in 2 files");
    expect(line).toContain("budget 180,000 B");
  });

  it("says `1 file`, not `1 files`, for a page that requests one", () => {
    const line = summaryLine("/x", summarise([script("/assets/a.js", 1_000)]));

    expect(line).toContain("in 1 file (budget");
  });
});

describe("describeInitialJs", () => {
  it("says by how much a page is over the budget and names the biggest files", () => {
    const summary = summarise([
      script("/assets/TimeField-a.js", 121_000),
      script("/assets/entry.client-b.js", 70_000),
      script("/assets/home-c.js", 15_000),
    ]);

    const text = describeInitialJs("/", summary);

    expect(text).toContain("/ downloads 206,000 B of gzipped JavaScript");
    expect(text).toContain("budget 180,000 B");
    expect(text).toContain("over by 26,000 B");
    expect(text.indexOf("TimeField-a.js")).toBeLessThan(text.indexOf("entry.client-b.js"));
    expect(text).toContain("121,000 B");
  });

  it("says how much room a page has left", () => {
    const text = describeInitialJs("/methodology", summarise([script("/assets/a.js", 150_000)]));

    expect(text).toContain("under by 30,000 B");
    expect(text).not.toContain("over by");
  });

  it("reports the MapLibre chunk on its own line and leaves it out of the total", () => {
    const text = describeInitialJs(
      "/",
      summarise([script("/assets/a.js", 10_000), script("/assets/MapView-b.js", 250_000)]),
    );

    expect(text).toContain("/ downloads 10,000 B of gzipped JavaScript");
    expect(text).toContain("not counted (MapLibre): 250,000 B");
    expect(text).toContain("/assets/MapView-b.js");
  });

  it("accepts a different budget", () => {
    const text = describeInitialJs("/x", summarise([script("/assets/a.js", 9_000)]), 8_000);

    expect(text).toContain("budget 8,000 B");
    expect(text).toContain("over by 1,000 B");
  });
});
