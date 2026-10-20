import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { tokens } from "./tokens/tokens";

/**
 * The stylesheets' rules, as checks (DESIGN.md sections 7 and 10, decision D-29): tokens only, and
 * no viewport or container threshold of a component's own. CSS cannot do either by itself: a media
 * or container condition cannot read a custom property, and nothing stops a literal. So the rules
 * are enforced here, over the source text of every stylesheet of the app. (Vitest swaps CSS imports
 * for empty modules, so the files are read from disk.)
 */

const APP = join(import.meta.dirname, "..");

/** Every `.css` file below `directory`. */
function stylesheetsIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return stylesheetsIn(path);
    }
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

/** Stylesheet name (`design-system/styles/base.css`) to its text; the generated tokens and the font faces are not rules. */
const SHEETS: ReadonlyMap<string, string> = new Map(
  stylesheetsIn(APP)
    .map((path) => [relative(APP, path).replaceAll("\\", "/"), path] as const)
    .filter(([name]) => !name.startsWith("design-system/tokens/") && !name.endsWith("fonts.css"))
    .map(([name, path]) => [name, readFileSync(path, "utf8")] as const),
);

const SHEET_NAMES = [...SHEETS.keys()].sort();

/** The source of a stylesheet without its comments. */
function source(name: string): string {
  return (SHEETS.get(name) ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The widths a condition compares against, as `[min | max, px]`. */
function widthFeatures(condition: string): readonly (readonly [string, number])[] {
  return [...condition.matchAll(/\((min|max)-width:\s*([\d.]+)(px|rem|em)\)/g)].map(
    ([, kind, value, unit]) => [String(kind), Number(value) * (unit === "px" ? 1 : 16)],
  );
}

/** Every `@media` and `@container` condition: `(min-width: 480px)`, `(prefers-reduced-motion: reduce)`. */
function conditions(name: string): readonly string[] {
  return [...source(name).matchAll(/@(?:media|container)\s*([^{]+)\{/g)].map(([, condition]) =>
    String(condition).trim(),
  );
}

/** A token's pixel value: `"480px"` is 480 and `"12rem"` is 192. */
function pixels(value: string | number): number {
  const text = String(value);
  return Number.parseFloat(text) * (text.endsWith("rem") ? 16 : 1);
}

/** The widths a query may name: the breakpoint scale and the component thresholds. */
const QUERY_WIDTHS: ReadonlyMap<number, string> = new Map(
  Object.entries(tokens.light)
    .filter(([name]) => name.startsWith("breakpoint-") || /^c-.+-min-width$/.test(name))
    .map(([name, value]) => [pixels(value), name]),
);

describe("the stylesheets", () => {
  it("finds the app's stylesheets", () => {
    expect(SHEET_NAMES.length).toBeGreaterThan(30);
    expect(QUERY_WIDTHS.size).toBeGreaterThanOrEqual(7);
  });

  describe("media and container queries (DESIGN.md section 7)", () => {
    const queries = SHEET_NAMES.flatMap((name) =>
      conditions(name).flatMap((condition) =>
        widthFeatures(condition).map(([kind, width]) => ({ name, condition, kind, width })),
      ),
    );

    it("exist (so the checks below prove something)", () => {
      expect(queries.length).toBeGreaterThan(10);
    });

    it.each(queries)("$name uses only min-width, mobile first: $condition", ({ kind }) => {
      expect(kind).toBe("min");
    });

    it.each(queries)("$name asks for a width that is a token: $condition", ({ width }) => {
      expect([...QUERY_WIDTHS.keys()]).toContain(width);
    });
  });

  describe("reduced motion (DESIGN.md section 6, R1-16)", () => {
    const sheet = source("design-system/styles/base.css");
    const reset = /@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(
      sheet,
    );
    const zeroed = [...(reset?.[1] ?? "").matchAll(/--motion-duration-([\w-]+):\s*0ms/g)].map(
      ([, name]) => String(name),
    );
    /** Intervals, not animations: the playback cadence and the hover delay of a tooltip. */
    const INTERVALS = ["frame", "tooltip-delay"];
    const animations = Object.keys(tokens.light)
      .filter((name) => name.startsWith("motion-duration-"))
      .map((name) => name.slice("motion-duration-".length))
      .filter((name) => !INTERVALS.includes(name));

    it("zeroes every animation duration and nothing else", () => {
      expect([...zeroed].sort()).toEqual([...animations].sort());
    });

    it("keeps the playback cadence and the tooltip delay", () => {
      expect(zeroed).not.toContain("frame");
      expect(zeroed).not.toContain("tooltip-delay");
    });
  });

  describe("literals (DESIGN.md section 10: tokens only)", () => {
    /**
     * Lengths and durations that stay literal, each with the reason. Everything else is a token.
     * A zero is not a value: `0ms` and `0px` always pass.
     */
    const ALLOWED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
      "design-system/components/VisuallyHidden/VisuallyHidden.module.css": {
        "1px":
          "The clip recipe's one pixel box: the standard screen-reader-only pattern, not a design size.",
        "-1px": "The same recipe's negative margin.",
      },
      "design-system/styles/risk.css": {
        "6px":
          "Pattern tiles are documented geometry (DESIGN.md section 4), shared by the map's SVG patterns.",
        "3px": "The dot of the 6 px dots tile.",
        "1.1px": "The dot's radius.",
        "1.3px": "The dot's soft edge.",
        "1.5px": "The hatch stripe width.",
        "2px": "The no-travel bars' stripe width (DESIGN.md section 4).",
        "1px": "The Unknown hatch's stripe width (DESIGN.md section 4).",
        "5px": "The Unknown hatch's tile (DESIGN.md section 4).",
      },
      "design-system/KitchenSink.module.css": {
        "22rem": "The /design page's own layout (an internal style guide, not a component).",
      },
      "design-system/components/Banner/Banner.module.css": {
        "6px":
          "The scenario banner's hatch uses the risk-pattern geometry (DESIGN.md sections 4 and 10).",
        "1.5px": "The hatch stripe width.",
      },
    };

    const literal = /(?<![\w.#-])-?(?:\d+\.?\d*|\.\d+)(?:px|rem|ms)\b/g;

    it.each(SHEET_NAMES)("%s has no unexplained length or duration", (name) => {
      const withoutConditions = source(name).replace(/@(?:media|container)\s*[^{]+\{/g, "{");
      const found = [...withoutConditions.matchAll(literal)]
        .map(([value]) => value)
        .filter((value) => Number.parseFloat(value) !== 0)
        .filter((value) => ALLOWED[name]?.[value] === undefined);

      expect(found).toEqual([]);
    });
  });
});
