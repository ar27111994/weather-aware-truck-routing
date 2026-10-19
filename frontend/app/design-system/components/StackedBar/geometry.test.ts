import { describe, expect, it } from "vitest";

import { layoutSegments, type MilesByLevel } from "./geometry";

const none: MilesByLevel = { low: 0, moderate: 0, high: 0, severe: 0, no_travel: 0, unknown: 0 };

describe("layoutSegments", () => {
  it.each([
    {
      name: "shares the width in proportion to the miles",
      miles: { ...none, low: 50, moderate: 30, high: 20 },
      width: 100,
      gap: 0,
      min: 3,
      widths: [50, 30, 20],
    },
    {
      name: "subtracts the gaps before sharing",
      miles: { ...none, low: 50, moderate: 50 },
      width: 101,
      gap: 1,
      min: 3,
      widths: [50, 50],
    },
    {
      name: "pins a tiny level at the minimum and takes it from the others",
      miles: { ...none, low: 999, no_travel: 1 },
      width: 103,
      gap: 1,
      min: 3,
      widths: [99, 3],
    },
    {
      name: "re-checks levels that fall under the minimum after pinning",
      miles: { ...none, low: 6, moderate: 3, high: 0.5 },
      width: 10,
      gap: 0,
      min: 3,
      widths: [4, 3, 3],
    },
    {
      name: "draws a lone level over the full width",
      miles: { ...none, unknown: 12 },
      width: 100,
      gap: 1,
      min: 3,
      widths: [100],
    },
  ])("$name", ({ miles, width, gap, min, widths }) => {
    const result = layoutSegments(miles, width, gap, min);

    expect(result.map((segment) => Math.round(segment.width))).toEqual(widths);
  });

  it("orders segments Low to No Travel, then Unknown, whatever the object order", () => {
    const result = layoutSegments(
      { unknown: 1, no_travel: 1, severe: 1, high: 1, moderate: 1, low: 1 },
      600,
      0,
      3,
    );

    expect(result.map((segment) => segment.level)).toEqual([
      "low",
      "moderate",
      "high",
      "severe",
      "no_travel",
      "unknown",
    ]);
  });

  it("omits zero-mile levels", () => {
    const result = layoutSegments({ ...none, moderate: 10, severe: 5 }, 100, 1, 3);

    expect(result.map((segment) => segment.level)).toEqual(["moderate", "severe"]);
  });

  it("places each segment after the previous one plus the gap", () => {
    const result = layoutSegments({ ...none, low: 1, high: 1 }, 101, 1, 3);

    expect(result.map((segment) => [segment.x, segment.width])).toEqual([
      [0, 50],
      [51, 50],
    ]);
  });

  it("returns nothing when there are no miles", () => {
    expect(layoutSegments(none, 100, 1, 3)).toEqual([]);
  });
});
