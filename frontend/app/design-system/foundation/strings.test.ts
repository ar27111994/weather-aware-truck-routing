import { describe, expect, it } from "vitest";

import { VOICE_RULES } from "../../../test/voice";
import microcopy from "./microcopy.json";
import { isStringKey, t, tList, tPlural } from "./strings";
import type { ListKey, StringKey } from "./strings";

/** Every string leaf (and list item) of microcopy.json with its dotted path; metadata keys skipped. */
function allStrings(node: unknown, path: string[] = []): [string, string][] {
  if (typeof node === "string") {
    return [[path.join("."), node]];
  }
  if (Array.isArray(node)) {
    return node.flatMap((item: unknown, index) => allStrings(item, [...path, String(index)]));
  }
  if (typeof node === "object" && node !== null) {
    return Object.entries(node)
      .filter(([key]) => !key.startsWith("$"))
      .flatMap(([key, value]) => allStrings(value, [...path, key]));
  }
  return [];
}

/** Lets a test hand the runtime guards a key the compiler would refuse. */
const asStringKey = (key: string): StringKey => key as StringKey;
const asListKey = (key: string): ListKey => key as ListKey;

const strings = allStrings(microcopy);

describe("t", () => {
  it("returns a string without placeholders unchanged", () => {
    expect(t("app.name")).toBe("Haulcast");
    expect(t("risk.no_travel")).toBe("No Travel");
  });

  it("fills placeholders with strings and numbers", () => {
    expect(t("rec.headline", { route: "B" })).toBe("Take Route B.");
    expect(
      t("route.cardAria", {
        route: "B",
        recommended: ", recommended",
        distance: 512.4,
        duration: "7 hours 44 minutes",
        level: "Moderate",
      }),
    ).toBe("Route B, recommended, 512.4 miles, 7 hours 44 minutes, highest risk Moderate");
  });

  it("fills the same placeholder wherever it appears", () => {
    expect(t("form.departure.zoneHint", { zone: "MDT", offset: "UTC−06:00" })).toBe(
      "Times are in your time zone, MDT, UTC−06:00.",
    );
  });

  it("throws when a placeholder has no value", () => {
    expect(() => t("rec.headline")).toThrow(
      'Microcopy key "rec.headline" needs a value for {route}.',
    );
  });

  it("throws on a key that is missing, a group, or a list (only reachable around the types)", () => {
    expect(() => t(asStringKey("rec.nope"))).toThrow('Unknown microcopy string "rec.nope".');
    expect(() => t(asStringKey("app.name.deeper"))).toThrow(
      'Unknown microcopy string "app.name.deeper".',
    );
    expect(() => t(asStringKey("rec"))).toThrow('Unknown microcopy string "rec".');
    expect(() => t(asStringKey("empty.steps"))).toThrow('Unknown microcopy string "empty.steps".');
  });
});

describe("isStringKey", () => {
  it("accepts keys that name a string, including ones built at runtime", () => {
    const code = "routing_unavailable";
    expect(isStringKey("app.name")).toBe(true);
    expect(isStringKey(`error.${code}.title`)).toBe(true);
  });

  it("rejects missing keys, groups and lists", () => {
    expect(isStringKey("error.not_a_code.title")).toBe(false);
    expect(isStringKey("error")).toBe(false);
    expect(isStringKey("empty.steps")).toBe(false);
    expect(isStringKey("app.name.deeper")).toBe(false);
  });
});

describe("tPlural", () => {
  it("uses the singular form for one", () => {
    expect(tPlural("status.planReady", 1, { route: "A" })).toBe(
      "Plan ready. 1 route found. Recommended: Route A.",
    );
  });

  it("uses the plural form for every other count", () => {
    expect(tPlural("status.planReady", 3, { route: "A" })).toBe(
      "Plan ready. 3 routes found. Recommended: Route A.",
    );
    expect(tPlural("route.fewerRoutes", 0)).toBe(
      "Only 0 distinct routes were available for this trip.",
    );
  });
});

describe("tList", () => {
  it("returns the items of a string list", () => {
    expect(tList("empty.steps")).toHaveLength(3);
    expect(tList("legend.band.wind")[0]).toBe("under 25 mph");
  });

  it("throws when the key is missing or not a list of strings (only reachable around the types)", () => {
    expect(() => tList(asListKey("app.name"))).toThrow('Unknown microcopy list "app.name"');
    expect(() => tList(asListKey("nope.list"))).toThrow('Unknown microcopy list "nope.list"');
  });
});

describe("microcopy.json voice rules (DESIGN.md section 13)", () => {
  it("contains the 312-plus strings the design contract promised", () => {
    expect(strings.length).toBeGreaterThanOrEqual(312);
  });

  it.each(VOICE_RULES)("has no %s in any string", (_rule, pattern) => {
    const offenders = strings.filter(([, value]) => pattern.test(value)).map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  it("uses the same {placeholder} syntax everywhere", () => {
    const malformed = strings.filter(([, value]) => /\{[^}]*[^\w}][^}]*\}|\{\}/.test(value));
    expect(malformed).toEqual([]);
  });

  it("states the scenario banner as the orchestrator's D-13 decision", () => {
    expect(t("banner.scenario.title")).toBe("Simulated weather. Not a forecast.");
  });

  it("labels the skip link for pages without a trip planner", () => {
    expect(t("app.skipToMain")).toBe("Skip to main content");
  });
});
