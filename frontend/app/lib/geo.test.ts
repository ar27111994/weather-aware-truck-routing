import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { LonLat } from "../api/contract";
import {
  boundingBox,
  cumulativeMiles,
  decodePolyline,
  encodePolyline,
  haversineMiles,
  positionAtDistance,
  positionAtElapsed,
  simplifyPath,
  sliceGeometry,
} from "./geo";

const GOOGLE_EXAMPLE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
const lonLat = fc.tuple(
  fc.double({ min: -179.9, max: 179.9, noNaN: true }),
  fc.double({ min: -85, max: 85, noNaN: true }),
);
const path = fc.array(lonLat, { minLength: 2, maxLength: 40 });
const round = (value: number, precision: number): number =>
  Math.round(value * 10 ** precision) / 10 ** precision + 0;

describe("polyline codec", () => {
  it("decodes Google's documented example (lat/lon pairs) into [lon, lat]", () => {
    expect(decodePolyline(GOOGLE_EXAMPLE, 5)).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
  });

  it("encodes the same example back to the documented string", () => {
    const coords: LonLat[] = [
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ];
    expect(encodePolyline(coords, 5)).toBe(GOOGLE_EXAMPLE);
  });

  it("decodes the same string at precision 6 as 10x smaller coordinates", () => {
    const five = decodePolyline(GOOGLE_EXAMPLE, 5);
    const six = decodePolyline(GOOGLE_EXAMPLE, 6);
    expect(six[0]?.[0]).toBeCloseTo((five[0]?.[0] ?? 0) / 10, 9);
  });

  it("returns no vertices for an empty string and an empty string for no vertices", () => {
    expect(decodePolyline("", 6)).toEqual([]);
    expect(encodePolyline([], 6)).toBe("");
  });

  it("round-trips an encoded vertex that crosses zero in both directions", () => {
    const coords: LonLat[] = [
      [0.00001, -0.00001],
      [-0.00002, 0.00003],
    ];
    expect(decodePolyline(encodePolyline(coords, 5), 5)).toEqual(coords);
  });

  it("rejects a polyline that ends in the middle of a value", () => {
    expect(() => decodePolyline("_p~iF~ps|", 5)).toThrow(new RangeError("Truncated polyline"));
    expect(() => decodePolyline("_p~iF", 5)).toThrow(RangeError);
  });

  it("rejects characters outside the polyline alphabet", () => {
    expect(() => decodePolyline("_p~iF ~ps|U", 5)).toThrow(RangeError);
    expect(() => decodePolyline("\u007f", 5)).toThrow(RangeError);
  });

  it("rejects an endless run of continuation characters", () => {
    expect(() => decodePolyline("~~~~~~~~~~~~", 5)).toThrow(
      new RangeError("Polyline value too long"),
    );
  });

  it.each([5, 6] as const)("round-trips any path at precision %i (property)", (precision) => {
    fc.assert(
      fc.property(path, (coords) => {
        const decoded = decodePolyline(encodePolyline(coords, precision), precision);
        expect(decoded).toEqual(
          coords.map(([lon, lat]) => [round(lon, precision), round(lat, precision)]),
        );
      }),
    );
  });
});

describe("haversineMiles", () => {
  it("is zero for identical points and symmetric", () => {
    expect(haversineMiles([-104.99, 39.74], [-104.99, 39.74])).toBe(0);
    const a: LonLat = [-111.891, 40.7608];
    const b: LonLat = [-104.9903, 39.7392];
    expect(haversineMiles(a, b)).toBeCloseTo(haversineMiles(b, a), 9);
  });

  it("measures Salt Lake City to Denver at roughly 370 miles", () => {
    expect(haversineMiles([-111.891, 40.7608], [-104.9903, 39.7392])).toBeCloseTo(371, 0);
  });

  it("measures one degree of latitude as 69.1 miles (mean Earth radius 3958.7613 mi)", () => {
    expect(haversineMiles([0, 0], [0, 1])).toBeCloseTo(69.09, 2);
  });
});

describe("cumulativeMiles", () => {
  const line: LonLat[] = [
    [0, 0],
    [0, 1],
    [0, 2],
  ];

  it("returns prefix sums starting at zero", () => {
    const result = cumulativeMiles(line);
    expect(result[0]).toBe(0);
    expect(result[2]).toBeCloseTo(2 * 69.09, 1);
    expect(result).toHaveLength(3);
  });

  it("rescales so the last value equals the provider's total exactly", () => {
    const result = cumulativeMiles(line, 100);
    expect(result).toEqual([0, 50, 100]);
  });

  it("returns zeros for a path with no length, and [] for no vertices", () => {
    expect(
      cumulativeMiles(
        [
          [1, 1],
          [1, 1],
        ],
        10,
      ),
    ).toEqual([0, 0]);
    expect(cumulativeMiles([])).toEqual([]);
  });

  it("is non-decreasing and ends at the total for any path (property)", () => {
    fc.assert(
      fc.property(path, fc.double({ min: 1, max: 5000, noNaN: true }), (coords, total) => {
        const result = cumulativeMiles(coords, total);
        const unscaled = cumulativeMiles(coords);
        expect(
          result.every((value, index) => index === 0 || value >= (result[index - 1] ?? 0)),
        ).toBe(true);
        if ((unscaled.at(-1) ?? 0) > 0) expect(result.at(-1)).toBe(total);
      }),
    );
  });
});

describe("boundingBox", () => {
  it("returns the west/south/east/north extent", () => {
    expect(
      boundingBox([
        [-111.8, 40.7],
        [-104.9, 39.7],
        [-108, 41.9],
      ]),
    ).toEqual({ west: -111.8, south: 39.7, east: -104.9, north: 41.9 });
  });

  it("rejects an empty path", () => {
    expect(() => boundingBox([])).toThrow(RangeError);
  });

  it("contains every vertex (property)", () => {
    fc.assert(
      fc.property(path, (coords) => {
        const box = boundingBox(coords);
        for (const [lon, lat] of coords) {
          expect(lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north).toBe(
            true,
          );
        }
      }),
    );
  });
});

describe("sliceGeometry", () => {
  const coords: LonLat[] = [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
  ];

  it("returns the inclusive range as a new array", () => {
    const slice = sliceGeometry(coords, 1, 2);
    expect(slice).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(slice).not.toBe(coords);
  });

  it("allows a single-vertex range and the whole path", () => {
    expect(sliceGeometry(coords, 3, 3)).toEqual([[3, 3]]);
    expect(sliceGeometry(coords, 0, 3)).toHaveLength(4);
  });

  it.each([
    [-1, 1],
    [2, 1],
    [0, 4],
    [0.5, 2],
    [0, 2.5],
  ])("rejects the range %f..%f", (start, end) => {
    expect(() => sliceGeometry(coords, start, end)).toThrow(RangeError);
  });

  it("holds end - start + 1 vertices for any valid range (property)", () => {
    fc.assert(
      fc.property(path, fc.nat(), fc.nat(), (points, a, b) => {
        const start = a % points.length;
        const end = start + (b % (points.length - start));
        expect(sliceGeometry(points, start, end)).toHaveLength(end - start + 1);
      }),
    );
  });
});

describe("interpolation along a path", () => {
  const coords: LonLat[] = [
    [0, 0],
    [10, 0],
    [10, 10],
  ];
  const cumulativeMi = [0, 100, 200];
  const cumulativeS = [0, 1000, 3000];

  it("returns the vertex at an exact cumulative value and a midpoint in between", () => {
    expect(positionAtDistance(coords, cumulativeMi, 0)).toEqual([0, 0]);
    expect(positionAtDistance(coords, cumulativeMi, 100)).toEqual([10, 0]);
    expect(positionAtDistance(coords, cumulativeMi, 50)).toEqual([5, 0]);
    expect(positionAtDistance(coords, cumulativeMi, 150)).toEqual([10, 5]);
  });

  it("clamps the distance to the ends of the path", () => {
    expect(positionAtDistance(coords, cumulativeMi, -5)).toEqual([0, 0]);
    expect(positionAtDistance(coords, cumulativeMi, 999)).toEqual([10, 10]);
  });

  it("interpolates by elapsed seconds, and is null before departure and after arrival", () => {
    expect(positionAtElapsed(coords, cumulativeS, 500)).toEqual([5, 0]);
    expect(positionAtElapsed(coords, cumulativeS, 2000)).toEqual([10, 5]);
    expect(positionAtElapsed(coords, cumulativeS, 0)).toEqual([0, 0]);
    expect(positionAtElapsed(coords, cumulativeS, 3000)).toEqual([10, 10]);
    expect(positionAtElapsed(coords, cumulativeS, -1)).toBeNull();
    expect(positionAtElapsed(coords, cumulativeS, 3001)).toBeNull();
  });

  it("does not divide by zero across a stop (equal consecutive values)", () => {
    const stopped = [0, 0, 100];
    expect(positionAtDistance(coords, stopped, 0)).toEqual([0, 0]);
    expect(positionAtDistance(coords, stopped, 50)).toEqual([10, 5]);
  });

  it("rejects mismatched lengths, too few vertices and NaN targets", () => {
    expect(() => positionAtDistance(coords, [0, 100], 10)).toThrow(RangeError);
    expect(() => positionAtDistance([[0, 0]], [0], 0)).toThrow(RangeError);
    expect(() => positionAtDistance(coords, cumulativeMi, Number.NaN)).toThrow(RangeError);
    expect(() => positionAtElapsed(coords, [0, 1], 0)).toThrow(RangeError);
    expect(() => positionAtElapsed([], [], 0)).toThrow(RangeError);
  });

  it("always lands inside the bounding box of the path (property)", () => {
    fc.assert(
      fc.property(path, fc.double({ min: 0, max: 1, noNaN: true }), (points, fraction) => {
        const cumulative = cumulativeMiles(points, 1000);
        const [lon, lat] = positionAtDistance(points, cumulative, fraction * 1000);
        const box = boundingBox(points);
        expect(lon).toBeGreaterThanOrEqual(box.west - 1e-9);
        expect(lon).toBeLessThanOrEqual(box.east + 1e-9);
        expect(lat).toBeGreaterThanOrEqual(box.south - 1e-9);
        expect(lat).toBeLessThanOrEqual(box.north + 1e-9);
      }),
    );
  });

  it("is null outside [0, last] and defined inside it (property)", () => {
    fc.assert(
      fc.property(path, fc.double({ min: -500, max: 1500, noNaN: true }), (points, elapsed) => {
        const cumulative = cumulativeMiles(points, 1000);
        const position = positionAtElapsed(points, cumulative, elapsed);
        expect(position === null).toBe(elapsed < 0 || elapsed > (cumulative.at(-1) ?? 0));
      }),
    );
  });
});

describe("simplifyPath", () => {
  const zigzag: LonLat[] = [
    [0, 0],
    [0.1, 0.0000001],
    [0.2, 0],
    [0.3, 0.2],
    [0.4, 0],
  ];
  const noisyL: LonLat[] = [
    [0, 0],
    [0.25, 0.00000001],
    [0.5, -0.00000001],
    [0.75, 0.00000001],
    [1, 0],
    [1, 0.5],
    [1, 1],
  ];

  it("drops near-collinear vertices and keeps the real corner", () => {
    expect(simplifyPath(noisyL, 0.1)).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
  });

  it("keeps every vertex that deviates more than the tolerance", () => {
    expect(simplifyPath(zigzag, 0.5)).toEqual([
      [0, 0],
      [0.2, 0],
      [0.3, 0.2],
      [0.4, 0],
    ]);
  });

  it("returns short paths unchanged (as a copy)", () => {
    const two: LonLat[] = [
      [0, 0],
      [1, 1],
    ];
    expect(simplifyPath(two, 5)).toEqual(two);
    expect(simplifyPath(two, 5)).not.toBe(two);
    expect(simplifyPath([], 5)).toEqual([]);
  });

  it("keeps only the endpoints when the tolerance is huge", () => {
    expect(simplifyPath(zigzag, 1e6)).toEqual([
      [0, 0],
      [0.4, 0],
    ]);
  });

  it("rejects a negative or NaN tolerance", () => {
    expect(() => simplifyPath(zigzag, -1)).toThrow(RangeError);
    expect(() => simplifyPath(zigzag, Number.NaN)).toThrow(RangeError);
  });

  it("handles tens of thousands of vertices without recursing", () => {
    const long: LonLat[] = Array.from({ length: 30_000 }, (_, index) => [
      index / 1000,
      Math.sin(index / 50) / 10,
    ]);
    const simplified = simplifyPath(long, 0.01);
    expect(simplified.length).toBeLessThan(long.length);
    expect(simplified[0]).toEqual(long[0]);
    expect(simplified.at(-1)).toEqual(long.at(-1));
  });

  it("keeps the endpoints and an ordered subsequence of the input (property)", () => {
    fc.assert(
      fc.property(path, fc.double({ min: 0, max: 50, noNaN: true }), (points, tolerance) => {
        const simplified = simplifyPath(points, tolerance);
        expect(simplified[0]).toEqual(points[0]);
        expect(simplified.at(-1)).toEqual(points.at(-1));
        let cursor = 0;
        for (const vertex of simplified) {
          const found = points.findIndex(
            (candidate, index) => index >= cursor && candidate === vertex,
          );
          expect(found).toBeGreaterThanOrEqual(cursor);
          cursor = found + 1;
        }
      }),
    );
  });
});
