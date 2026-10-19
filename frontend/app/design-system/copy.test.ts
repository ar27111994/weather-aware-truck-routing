import { describe, expect, it } from "vitest";

import { copy, format } from "./copy";

describe("format", () => {
  it("fills every placeholder, converting numbers to text", () => {
    expect(format(copy.status.planReady_other, { count: 3, route: "B" })).toBe(
      "Plan ready. 3 routes found. Recommended: Route B.",
    );
  });

  it("fills a placeholder that appears more than once", () => {
    expect(format("{a} and {a}", { a: "x" })).toBe("x and x");
  });

  it("leaves a placeholder without a value visible instead of rendering a blank", () => {
    expect(format(copy.rec.headline, {})).toBe("Take Route {route}.");
  });

  it("returns a template without placeholders unchanged", () => {
    expect(format(copy.search.retry, { unused: 1 })).toBe(copy.search.retry);
  });
});

describe("copy", () => {
  it("carries the voice rules: no emoji, arrows or inequality signs in any string", () => {
    const strings: string[] = [];
    const collect = (node: unknown): void => {
      if (typeof node === "string") strings.push(node);
      else if (Array.isArray(node)) node.forEach(collect);
      else if (typeof node === "object" && node !== null) Object.values(node).forEach(collect);
    };
    collect(copy);
    expect(strings.length).toBeGreaterThan(300);
    for (const text of strings) {
      expect(text).not.toMatch(/[\u2190-\u21FF\u2264\u2265]|\uFE0F|\p{Emoji_Presentation}/u);
    }
  });
});
