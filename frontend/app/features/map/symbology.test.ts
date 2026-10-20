import { describe, expect, it } from "vitest";

import { tokens } from "../../design-system/tokens/tokens";
import {
  MAP_RISK_KEYS,
  hoverExtra,
  px,
  ribbonColor,
  riskFill,
  riskOnFill,
  riskStroke,
  routeWidths,
  unknownDash,
  unselectedOpacity,
  zoomWidth,
} from "./symbology";

describe("px", () => {
  it("reads a pixel token and rejects any other unit", () => {
    expect(px("4px")).toBe(4);
    expect(px("1.5px")).toBe(1.5);
    expect(() => px("4em")).toThrow(RangeError);
  });
});

describe("route widths (DESIGN.md section 9.3)", () => {
  it("gives the selected route a 4/6/9 px ribbon with a 4 px casing and a 3 px ink outline", () => {
    expect(routeWidths(true)).toEqual({
      ribbon: [4, 6, 9],
      casing: [8, 10, 13],
      outline: [11, 13, 16],
    });
  });

  it("gives the other routes a 2/3/5 px ribbon", () => {
    expect(routeWidths(false)).toMatchObject({ ribbon: [2, 3, 5], casing: [6, 7, 9] });
  });

  it("interpolates by zoom at 4, 8 and 12, adding a constant or an expression", () => {
    expect(zoomWidth([1, 2, 3])).toEqual(["interpolate", ["linear"], ["zoom"], 4, 1, 8, 2, 12, 3]);
    expect(zoomWidth([1, 2, 3], 1)).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      4,
      2,
      8,
      3,
      12,
      4,
    ]);
    expect(zoomWidth([1, 2, 3], hoverExtra())).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      4,
      ["+", 1, hoverExtra()],
      8,
      ["+", 2, hoverExtra()],
      12,
      ["+", 3, hoverExtra()],
    ]);
  });

  it("widens a hovered route by the hover token", () => {
    expect(hoverExtra()).toEqual(["case", ["boolean", ["feature-state", "hover"], false], 1.5, 0]);
  });

  it("mutes other routes to the token opacity", () => {
    expect(unselectedOpacity()).toBe(0.9);
  });
});

describe("risk colours", () => {
  it("come from the generated tokens of each theme", () => {
    for (const theme of ["light", "dark"] as const) {
      expect(riskFill(theme, "no_travel")).toBe(tokens[theme]["risk-no-travel-fill"]);
      expect(riskStroke(theme, "low")).toBe(tokens[theme]["risk-low-stroke"]);
      expect(riskOnFill(theme, "unknown")).toBe(tokens[theme]["risk-unknown-on-fill"]);
    }
  });

  it("colour the ribbon by level with Unknown as the fallback, never as Low (D-31)", () => {
    const expression: readonly unknown[] = ribbonColor("light");

    expect(expression.slice(0, 2)).toEqual(["match", ["get", "level"]]);
    for (const key of MAP_RISK_KEYS.slice(0, 5)) {
      expect(expression[expression.indexOf(key) + 1]).toBe(riskFill("light", key));
    }
    expect(expression.at(-1)).toBe(riskFill("light", "unknown"));
    expect(riskFill("light", "unknown")).not.toBe(riskFill("light", "low"));
  });

  it("dash only Unknown stretches, 1.4 on and 1.1 off", () => {
    expect(unknownDash()).toEqual([1.4, 1.1]);
  });
});
