import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { HEATMAP_FRAME_COUNT } from "../../api/contract";
import type { Heatmap } from "../../api/contract";
import { minimalHeatmap } from "../../api/mocks";
import { RISK_RULES } from "../../lib/risk";
import {
  HEATMAP_LAYERS,
  NOT_SET,
  UNKNOWN_VALUE,
  buildCellCollection,
  decodeHeatmap,
  fieldStops,
  frameChanges,
  heatmapPaint,
  legendTicks,
} from "./heatmap";
import { palette, riskFill } from "./symbology";

/** Evaluates a `step` expression the way MapLibre does: the output of the last stop <= input. */
function evaluateStep(expression: unknown, input: number): unknown {
  if (!Array.isArray(expression) || expression[0] !== "step") throw new Error("not a step");
  let output: unknown = expression[2];
  for (let i = 3; i < expression.length; i += 2) {
    if (input >= Number(expression[i])) output = expression[i + 1];
  }
  return output;
}

/** Evaluates the `case` opacity expressions of {@link heatmapPaint} for a feature-state value. */
function evaluateCase(expression: unknown, v: number): unknown {
  if (!Array.isArray(expression) || expression[0] !== "case") throw new Error("not a case");
  for (let i = 1; i < expression.length - 1; i += 2) {
    const condition: unknown = expression[i];
    if (!Array.isArray(condition)) throw new Error("not a comparison");
    const [operator, , bound] = condition as [string, unknown, number];
    const holds = operator === "<" ? v < bound : operator === "==" ? v === bound : false;
    if (holds) return expression[i + 1];
  }
  return expression.at(-1);
}

function heatmapWith(overrides: Partial<Heatmap>): Heatmap {
  return { ...minimalHeatmap(), ...overrides };
}

describe("buildCellCollection (D-22: south-west corner, rows north, cols east)", () => {
  it("draws each cell of an asymmetric 2 x 3 grid at exactly its corners, id = row * cols + col", () => {
    const grid = { lat0: 10, lon0: 100, dlat: 0.5, dlon: 0.25, rows: 2, cols: 3 };

    const collection = buildCellCollection(grid, [0, 1, 2, 3, 4, 5]);

    const corners = collection.features.map((feature) => [
      feature.id,
      feature.geometry.coordinates,
    ]);
    expect(corners).toEqual([
      [
        0,
        [
          [
            [100, 10],
            [100.25, 10],
            [100.25, 10.5],
            [100, 10.5],
            [100, 10],
          ],
        ],
      ],
      [
        1,
        [
          [
            [100.25, 10],
            [100.5, 10],
            [100.5, 10.5],
            [100.25, 10.5],
            [100.25, 10],
          ],
        ],
      ],
      [
        2,
        [
          [
            [100.5, 10],
            [100.75, 10],
            [100.75, 10.5],
            [100.5, 10.5],
            [100.5, 10],
          ],
        ],
      ],
      [
        3,
        [
          [
            [100, 10.5],
            [100.25, 10.5],
            [100.25, 11],
            [100, 11],
            [100, 10.5],
          ],
        ],
      ],
      [
        4,
        [
          [
            [100.25, 10.5],
            [100.5, 10.5],
            [100.5, 11],
            [100.25, 11],
            [100.25, 10.5],
          ],
        ],
      ],
      [
        5,
        [
          [
            [100.5, 10.5],
            [100.75, 10.5],
            [100.75, 11],
            [100.5, 11],
            [100.5, 10.5],
          ],
        ],
      ],
    ]);
  });

  it("draws only the corridor cells the heatmap lists", () => {
    const grid = { lat0: 0, lon0: 0, dlat: 1, dlon: 1, rows: 2, cols: 3 };

    expect(buildCellCollection(grid, [1, 5]).features.map((feature) => feature.id)).toEqual([1, 5]);
  });

  it("tiles the plane: neighbouring cells share their edges exactly (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        fc.double({ min: 0.1, max: 0.5, noNaN: true }),
        (rows, cols, spacing) => {
          const grid = { lat0: 30.05, lon0: -110.05, dlat: spacing, dlon: spacing, rows, cols };
          const all = Array.from({ length: rows * cols }, (_unused, i) => i);
          const features = buildCellCollection(grid, all).features;
          for (const feature of features) {
            const index = Number(feature.id);
            const ring = feature.geometry.coordinates[0] ?? [];
            const east = features[index + 1];
            if ((index + 1) % cols !== 0 && east) {
              expect(east.geometry.coordinates[0]?.[0]).toEqual(ring[1]);
            }
          }
        },
      ),
    );
  });
});

describe("decodeHeatmap", () => {
  it("slices every field into typed arrays, frame-major, once", () => {
    const cells = [0, 3];
    const length = HEATMAP_FRAME_COUNT * cells.length;
    const wind = Array.from({ length }, (_unused, i) => i / 10);
    const heatmap = heatmapWith({
      fields: {
        risk: Array.from({ length }, (_unused, i) => (i % 2 === 0 ? -1 : 4)),
        wind_mph: wind,
        gust_mph: wind,
        rain_in_hr: Array.from({ length }, () => null),
        snow_in_hr: Array.from({ length }, () => 3.001),
      },
    });

    const frames = decodeHeatmap(heatmap);

    expect(frames.cellIds).toEqual(Int32Array.from(cells));
    expect(frames.risk).toBeInstanceOf(Int8Array);
    expect(Array.from(frames.risk.subarray(0, 4))).toEqual([-1, 4, -1, 4]);
    expect(frames.wind_mph).toBeInstanceOf(Float64Array);
    expect(frames.wind_mph[97]).toBe(9.7);
    // Missing values become the Unknown sentinel, never 0 (which would read as calm, D-31).
    expect(Array.from(frames.rain_in_hr.subarray(0, 3))).toEqual([
      UNKNOWN_VALUE,
      UNKNOWN_VALUE,
      UNKNOWN_VALUE,
    ]);
    // 64-bit floats keep a value just past a band edge past it (float32 would round 3.001 down).
    expect(frames.snow_in_hr[0]).toBe(3.001);
    expect(frames.startTime).toBe(Date.parse(heatmap.start_time));
  });

  it("returns the same decoded frames for the same heatmap object", () => {
    const heatmap = minimalHeatmap();

    expect(decodeHeatmap(heatmap)).toBe(decodeHeatmap(heatmap));
  });

  it("reads one frame of one layer as a view, without copying", () => {
    const frames = decodeHeatmap(minimalHeatmap());

    const view = frames.frame("wind_mph", 3);

    expect(Array.from(view)).toEqual([12.3, 12.3]);
    expect(view.buffer).toBe(frames.wind_mph.buffer);
  });

  it("rejects a frame outside 0..48", () => {
    const frames = decodeHeatmap(minimalHeatmap());

    expect(() => frames.frame("risk", 49)).toThrow(RangeError);
    expect(() => frames.frame("risk", -1)).toThrow(RangeError);
    expect(() => frames.frame("risk", 1.5)).toThrow(RangeError);
  });
});

describe("frameChanges", () => {
  it("lists only the cells whose value differs from the previous frame", () => {
    const previous = Float64Array.from([1, 2, 3]);
    const next = Float64Array.from([1, 5, 3]);

    expect(frameChanges(previous, next)).toEqual([1]);
  });

  it("lists every cell when there is no previous frame", () => {
    expect(frameChanges(undefined, Int8Array.from([0, 0]))).toEqual([0, 1]);
  });
});

describe("fieldStops (bin edges from shared/risk-rules.json plus the display floor)", () => {
  it("starts wind at the 15 mph floor, then the lower-inclusive band edges", () => {
    expect(fieldStops("wind_mph")).toEqual([15, 25, 35, 45, 55]);
  });

  it("moves an upper-inclusive edge up by the field's precision (rain Severe includes 1.00)", () => {
    expect(fieldStops("rain_in_hr")).toEqual([0.01, 0.1, 0.25, 0.5, 1.001]);
    expect(fieldStops("snow_in_hr")).toEqual([0.01, 0.5, 1, 2, 3.001]);
  });

  it("follows the rules file: a changed band edge moves its stop", () => {
    const rules = structuredClone(RISK_RULES);
    const moderate = rules.factors.wind.bands[1];
    if (moderate) moderate.min_inclusive = 30;

    expect(fieldStops("wind_mph", rules)).toEqual([15, 30, 35, 45, 55]);
  });

  it("fails loudly on a rules file whose ladder has a band without a lower edge", () => {
    const rules = structuredClone(RISK_RULES);
    rules.factors.snow.bands = rules.factors.snow.bands.filter((band) => band.level !== "high");

    expect(() => fieldStops("snow_in_hr", rules)).toThrow(/high no lower edge/);
    expect(() => legendTicks("snow_in_hr", rules)).toThrow(RangeError);
  });
});

describe("heatmapPaint", () => {
  it("colours the risk layer by level, Unknown in its own grey (never Low, D-31)", () => {
    const paint = heatmapPaint("risk", "light");
    const color = paint["fill-color"];

    expect(evaluateStep(color, UNKNOWN_VALUE)).toBe(riskFill("light", "unknown"));
    expect(evaluateStep(color, 0)).toBe(riskFill("light", "low"));
    expect(evaluateStep(color, 2)).toBe(riskFill("light", "high"));
    expect(evaluateStep(color, 4)).toBe(riskFill("light", "no_travel"));
  });

  it("keeps Low quiet and every other level at the risk opacity, per theme", () => {
    for (const theme of ["light", "dark"] as const) {
      const opacity = heatmapPaint("risk", theme)["fill-opacity"];
      const p = palette(theme);

      expect(evaluateCase(opacity, NOT_SET)).toBe(0);
      expect(evaluateCase(opacity, 0)).toBe(p["heatmap-risk-opacity-low"]);
      expect(evaluateCase(opacity, 3)).toBe(p["heatmap-risk-opacity"]);
      expect(evaluateCase(opacity, UNKNOWN_VALUE)).toBe(p["heatmap-risk-opacity"]);
    }
  });

  it("puts a value exactly on a band edge in the higher bin, and 1.000 in/hr of rain still in bin 4", () => {
    const rain = heatmapPaint("rain_in_hr", "light")["fill-color"];
    const p = palette("light");

    expect(evaluateStep(rain, 0.1)).toBe(p["heatmap-rain-bin-2"]);
    expect(evaluateStep(rain, 0.099)).toBe(p["heatmap-rain-bin-1"]);
    expect(evaluateStep(rain, 1)).toBe(p["heatmap-rain-bin-4"]);
    expect(evaluateStep(rain, 1.001)).toBe(p["heatmap-rain-bin-5"]);
  });

  it("leaves a value under the display floor unshaded and shows Unknown, not calm, for a missing value", () => {
    for (const theme of ["light", "dark"] as const) {
      const paint = heatmapPaint("wind_mph", theme);
      const p = palette(theme);

      expect(evaluateCase(paint["fill-opacity"], 14.9)).toBe(0);
      expect(evaluateCase(paint["fill-opacity"], 15)).toBe(p["heatmap-opacity"]);
      expect(evaluateCase(paint["fill-opacity"], NOT_SET)).toBe(0);
      expect(evaluateCase(paint["fill-opacity"], UNKNOWN_VALUE)).toBe(
        p["heatmap-risk-opacity-low"],
      );
      expect(evaluateStep(paint["fill-color"], UNKNOWN_VALUE)).toBe(riskFill(theme, "unknown"));
      expect(evaluateStep(paint["fill-color"], 55)).toBe(p["heatmap-wind-bin-5"]);
      expect(evaluateStep(paint["fill-color"], 30)).toBe(p["heatmap-wind-bin-2"]);
    }
  });

  it("uses the snow ramp for snow", () => {
    expect(evaluateStep(heatmapPaint("snow_in_hr", "dark")["fill-color"], 2)).toBe(
      palette("dark")["heatmap-snow-bin-4"],
    );
  });

  it("names the four layers the switch offers, in order", () => {
    expect(HEATMAP_LAYERS).toEqual(["risk", "wind_mph", "rain_in_hr", "snow_in_hr"]);
  });
});

describe("legendTicks", () => {
  it("prints each step's lower edge with the field's precision", () => {
    expect(legendTicks("wind_mph")).toEqual(["15", "25", "35", "45", "55"]);
    expect(legendTicks("rain_in_hr")).toEqual(["0.01", "0.10", "0.25", "0.50", "1.00"]);
    expect(legendTicks("snow_in_hr")).toEqual(["0.01", "0.5", "1.0", "2.0", "3.0"]);
  });
});
