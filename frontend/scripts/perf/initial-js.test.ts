import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  INITIAL_JS_BUDGET_BYTES,
  INPUT_JS_BUDGET_BYTES,
  capProblem,
  describeInitialJs,
  isMapLibreChunk,
  measureScript,
  summarise,
} from "./initial-js.ts";
import type { ScriptFile } from "./initial-js.ts";

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
// cap, so a later change cannot spend the room a lower cap gave up.
const D49_CEILING_BYTES = 343_169;

describe("the planner's cap after one input (D-46 3.5(c), D-49)", () => {
  it("never rises above the ceiling D-49 set", () => {
    expect(INPUT_JS_BUDGET_BYTES).toBeLessThanOrEqual(D49_CEILING_BYTES);
  });
});

describe("capProblem", () => {
  it("accepts a total that is exactly the cap", () => {
    expect(capProblem(343_169, 343_169)).toBeNull();
  });

  it("refuses a total over the cap and says that the cap does not rise", () => {
    const problem = capProblem(343_170, 343_169);

    expect(problem).toContain("1 B over the cap");
    expect(problem).toContain("never rises");
  });

  it("refuses a total under the cap and says what to lower the cap to", () => {
    const problem = capProblem(343_100, 343_169);

    expect(problem).toContain("69 B under the cap");
    expect(problem).toContain("lower INPUT_JS_BUDGET_BYTES to 343,100");
  });

  it("holds the planner's cap when none is given", () => {
    expect(capProblem(INPUT_JS_BUDGET_BYTES)).toBeNull();
    expect(capProblem(INPUT_JS_BUDGET_BYTES + 1)).not.toBeNull();
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
      rawBytes: 0,
      gzipBytes: 0,
      excludedGzipBytes: 0,
    });
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
