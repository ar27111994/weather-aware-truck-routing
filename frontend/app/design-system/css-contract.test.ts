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

/** A token's pixel value: `"480px"` is 480 and `"12rem"` is 192; anything that is not a length is NaN. */
function pixels(value: unknown): number {
  if (typeof value !== "string") {
    return Number.NaN;
  }
  return Number.parseFloat(value) * (value.endsWith("rem") ? 16 : 1);
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
      "features/methodology/MethodologyPage.module.css": {
        "14rem":
          "The table-of-contents column of the methodology page: a page layout width, not a component size.",
      },
      "features/methodology/RiskTable.module.css": {
        "36rem":
          "The width below which the thresholds table scrolls sideways instead of squeezing its five level columns.",
      },
      "design-system/components/Banner/Banner.module.css": {
        "6px":
          "The scenario banner's hatch uses the risk-pattern geometry (DESIGN.md sections 4 and 10).",
        "1.5px": "The hatch stripe width.",
      },
      "features/map/MapView.module.css": {
        "1px": "The popover's anchor: a one-pixel point the popover is placed against, not a size.",
        "10px":
          "MapLibre's control margin (maplibre-gl.css); Fit routes lines up with its controls.",
        "29px": "MapLibre's zoom button size (maplibre-gl.css); Fit routes sits below the two.",
        "2px":
          "The truck marker's icon-to-letter gap: half a space step keeps the plate near its 32 px square (DESIGN.md section 9.6).",
        "4px": "The origin pin's centre dot radius: drawn geometry, like the risk patterns.",
        "4.5px": "The same dot's half-pixel soft edge.",
      },
      "features/map/MapLegend.module.css": {
        "1px": "The Unknown hatch's stripe width (DESIGN.md section 4), as in styles/risk.css.",
        "5px": "The Unknown hatch's tile (DESIGN.md section 4).",
      },
      "routes/design-map.module.css": {
        "32rem":
          "The /design/map harness's least map height, so the legend and dock never overlap (an internal tool, not a component).",
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

  describe("layers (DESIGN.md section 5: the z scale is tokens, R3-30)", () => {
    /**
     * Stacking ranks that stay literal, each with the reason: a number that only orders things inside
     * one stacking context, so no page layer applies. A token for it would replace them.
     */
    const RANKS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
      "design-system/components/Table/Table.module.css": {
        "1": "The sticky header cells above the rows, inside the region's own stacking context (`isolation: isolate`).",
      },
      "features/planner/PlannerPanel.module.css": {
        "1": "The busy indicator above the rest of the panel: a rank among the panel's own children, not a page layer.",
      },
    };

    /** The value of every `z-index` declaration of a stylesheet: `var(--z-sheet)`, `auto`, `1`. */
    function layers(name: string): string[] {
      return [...source(name).matchAll(/(?<![\w-])z-index:\s*([^;}]+)/g)].map(([, value]) =>
        String(value).trim(),
      );
    }

    const scale = Object.keys(tokens.light).filter((name) => name.startsWith("z-"));
    const isRank = (value: string): boolean =>
      value !== "auto" && !scale.some((name) => value === `var(--${name})`);
    const explained = Object.entries(RANKS).flatMap(([name, ranks]) =>
      Object.keys(ranks).map((value) => [name, value] as const),
    );

    it("finds the z scale and the layers that use it", () => {
      expect(scale.length).toBeGreaterThanOrEqual(10);
      expect(SHEET_NAMES.flatMap(layers).length).toBeGreaterThan(10);
    });

    it.each(SHEET_NAMES)("%s layers with the z scale, or explains a local rank", (name) => {
      const found = layers(name)
        .filter(isRank)
        .filter((value) => RANKS[name]?.[value] === undefined);

      expect(found).toEqual([]);
    });

    it.each(explained)("%s still has the rank %s that it explains", (name, value) => {
      expect(layers(name)).toContain(value);
    });
  });

  describe("shared stylesheets sit in a nested layer (R4-01: the order the files load in must not matter)", () => {
    /**
     * Stylesheets whose classes other components wear next to their own, each with the reason. A
     * component's own rule has to win over theirs whatever the order the two files load in. The page
     * links every stylesheet of the planner a second time when the planner's code arrives, and while
     * only some of the copies had loaded, the copy of FieldParts sat after the number field's and
     * won every tie of specificity: the padding that the number field and the date picker take away
     * came back for 30 ms (12 px). The rules of a nested layer lose to the rules that their parent
     * layer holds itself, in whatever order the files come and however specific the selectors are.
     */
    const SHARED: Readonly<Record<string, string>> = {
      "design-system/components/_shared/FieldParts/FieldParts.module.css":
        "The box, label, hint and error that every field wears; the number field and the date picker take its padding away.",
      "design-system/components/ComboBox/ListParts.module.css":
        "The popover list that the combo box and the select share; each adds its own sizes.",
    };

    /** Whether a stylesheet puts its rules in `components.parts`, spelled either way. */
    function inParts(name: string): boolean {
      const text = source(name);
      return (
        /@layer\s+components\.parts\s*\{/.test(text) ||
        /@layer\s+components\s*\{\s*@layer\s+parts\s*\{/.test(text)
      );
    }

    it.each(Object.entries(SHARED))(
      "%s is in the nested layer components.parts",
      (name, reason) => {
        expect(SHEETS.has(name), `${name} is not a stylesheet of the app`).toBe(true);
        expect(inParts(name), `write its rules in @layer components.parts { ... }: ${reason}`).toBe(
          true,
        );
      },
    );

    it("keeps the nested layer for the shared stylesheets alone, so that it still means something", () => {
      expect(SHEET_NAMES.filter(inParts)).toEqual(Object.keys(SHARED).sort());
    });
  });

  describe("a disabled field keeps the cursor of FieldParts (R4-01: the shared rules sit below the component's own)", () => {
    /**
     * FieldParts shows `not-allowed` over a disabled control. Its rules sit in a layer below those of
     * the component, so a component's own `cursor: pointer` on the same control would beat it, and a
     * disabled one would invite a click. Every `cursor: pointer` of a field's stylesheet therefore
     * leaves the disabled state out of its selector, or the sheet says what a disabled one shows.
     */
    const FIELD_SHEETS = [
      "design-system/components/_shared/FieldParts/FieldParts.module.css",
      "design-system/components/ComboBox/ComboBox.module.css",
      "design-system/components/DatePicker/DatePicker.module.css",
      "design-system/components/NumberField/NumberField.module.css",
      "design-system/components/Select/Select.module.css",
      "design-system/components/TextField/TextField.module.css",
      "design-system/components/TimeField/Segments.module.css",
    ];

    /** The innermost rules of a stylesheet: selector and declarations. */
    function rulesOf(name: string): { selector: string; body: string }[] {
      return [...source(name).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
        selector: String(selector).trim(),
        body: String(body),
      }));
    }

    it.each(FIELD_SHEETS)("%s shows a pointer only over what is enabled", (name) => {
      const rules = rulesOf(name);
      const saysDisabled = rules.some(
        ({ selector, body }) =>
          /\[data-disabled\]|:disabled/.test(selector) && /cursor:\s*not-allowed/.test(body),
      );
      const unguarded = rules
        .filter(({ body }) => /cursor:\s*pointer/.test(body))
        .map(({ selector }) => selector)
        .filter((selector) => !saysDisabled && !selector.includes(":not([data-disabled])"));

      expect(unguarded).toEqual([]);
    });
  });
});
