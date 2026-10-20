import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Plan, Route } from "../../api/contract";
import { minimalPlan } from "../../api/mocks";
import {
  CHECKPOINT_ID_STRIDE,
  buildCheckpointCollection,
  buildRibbonCollection,
  buildRouteCollection,
  checkpointFeatureId,
  ribbonStretches,
  routeBounds,
} from "./features";

type Coord = [number, number];

function route(overrides: Partial<Route> = {}): Route {
  const [base] = minimalPlan().routes;
  if (!base) throw new Error("the minimal plan has a route");
  return { ...base, ...overrides };
}

function planWith(routes: readonly Route[]): Plan {
  return { ...minimalPlan(), routes: [...routes] };
}

const LINE: Coord[] = [
  [0, 0],
  [1, 0],
  [2, 0],
  [3, 0],
  [4, 0],
  [5, 0],
];

describe("ribbonStretches", () => {
  it("gives each checkpoint its own vertices plus the next checkpoint's first one, so stretches meet without a gap", () => {
    const stretches = ribbonStretches(LINE, [
      { start: 0, end: 1 },
      { start: 2, end: 3 },
      { start: 4, end: 5 },
    ]);

    expect(stretches).toEqual([
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
      [
        [2, 0],
        [3, 0],
        [4, 0],
      ],
      [
        [4, 0],
        [5, 0],
      ],
    ]);
  });

  it("keeps a stretch that already reaches the next checkpoint as it is", () => {
    expect(
      ribbonStretches(LINE, [
        { start: 0, end: 3 },
        { start: 3, end: 5 },
      ]),
    ).toEqual([LINE.slice(0, 4), LINE.slice(3)]);
  });

  it("leaves out a stretch of a single vertex (a line needs two)", () => {
    expect(
      ribbonStretches(LINE, [
        { start: 0, end: 5 },
        { start: 5, end: 5 },
      ]),
    ).toEqual([LINE, null]);
  });

  it("covers every vertex of the route exactly once per stretch boundary (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 40 }),
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 12 }),
        (vertexCount, widths) => {
          const coords: Coord[] = Array.from({ length: vertexCount }, (_unused, i) => [i, 0]);
          const spans: { start: number; end: number }[] = [];
          let start = 0;
          for (const width of widths) {
            if (start >= vertexCount) break;
            const end = Math.min(vertexCount - 1, start + width - 1);
            spans.push({ start, end });
            start = end + 1;
          }
          // The API's checkpoints partition the whole geometry: the last one owns the last vertex.
          const lastSpan = spans.at(-1);
          if (lastSpan) spans[spans.length - 1] = { start: lastSpan.start, end: vertexCount - 1 };
          const stretches = ribbonStretches(coords, spans).filter((s) => s !== null);
          const joined = stretches.flatMap((stretch, i) => (i === 0 ? stretch : stretch.slice(1)));
          // Consecutive stretches share their joint vertex, and together they trace the whole line.
          stretches.slice(1).forEach((stretch, i) => {
            expect(stretch[0]).toEqual(stretches[i]?.at(-1));
          });
          expect(joined).toEqual(coords.slice(0, joined.length));
          expect(joined.at(-1)).toEqual(coords.at(-1));
        },
      ),
    );
  });
});

describe("buildRouteCollection", () => {
  it("has one line per route, its position as the id, and the route id, rank and recommendation as properties", () => {
    const a = route({ route_id: "A", rank: 1, recommended: true });
    const b = route({ route_id: "B", rank: 2, recommended: false });

    const collection = buildRouteCollection(planWith([a, b]));

    expect(collection.features).toEqual([
      {
        type: "Feature",
        id: 0,
        geometry: a.geometry,
        properties: { route_id: "A", rank: 1, recommended: true },
      },
      {
        type: "Feature",
        id: 1,
        geometry: b.geometry,
        properties: { route_id: "B", rank: 2, recommended: false },
      },
    ]);
  });
});

describe("buildRibbonCollection", () => {
  it("leaves out a checkpoint that owns a single vertex and has no next checkpoint to reach", () => {
    const base = route();
    const [first, second] = base.checkpoints;
    if (!first || !second) throw new Error("the minimal route has two checkpoints");
    const r = route({
      checkpoints: [
        { ...first, coord_start: 0, coord_end: 2 },
        { ...second, coord_start: 2, coord_end: 2 },
      ],
    });

    const collection = buildRibbonCollection(planWith([r]));

    expect(collection.features.map((feature) => feature.properties.index)).toEqual([0]);
  });

  it("draws one stretch per checkpoint with its route, index and level, Unknown spelled out", () => {
    const base = route();
    const [first, second] = base.checkpoints;
    if (!first || !second) throw new Error("the minimal route has two checkpoints");
    const coords: Coord[] = [
      [-111, 40],
      [-110, 40],
      [-109, 40],
    ];
    const r = route({
      route_id: "B",
      geometry: { type: "LineString", coordinates: coords },
      cumulative_mi: [0, 50, 100],
      cumulative_s: [0, 3000, 6000],
      checkpoints: [
        {
          ...first,
          index: 0,
          coord_start: 0,
          coord_end: 0,
          risk: { ...first.risk, level: "high" },
        },
        {
          ...second,
          index: 1,
          coord_start: 1,
          coord_end: 2,
          risk: { ...second.risk, level: null },
        },
      ],
    });

    const collection = buildRibbonCollection(planWith([r]));

    expect(collection.features).toEqual([
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords.slice(0, 2) },
        properties: { route_id: "B", index: 0, level: "high" },
      },
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords.slice(1, 3) },
        properties: { route_id: "B", index: 1, level: "unknown" },
      },
    ]);
  });
});

describe("checkpointFeatureId", () => {
  it("is unique per route position and checkpoint index, and an integer (feature-state needs one)", () => {
    expect(checkpointFeatureId(0, 7)).toBe(7);
    expect(checkpointFeatureId(2, 7)).toBe(2 * CHECKPOINT_ID_STRIDE + 7);
  });

  it("rejects an index the stride cannot hold, so two checkpoints never share an id", () => {
    expect(() => checkpointFeatureId(0, CHECKPOINT_ID_STRIDE)).toThrow(RangeError);
    expect(() => checkpointFeatureId(0, -1)).toThrow(RangeError);
  });
});

describe("buildCheckpointCollection", () => {
  const label = (checkpoint: { readonly index: number }): string => `T${String(checkpoint.index)}`;

  it("marks every checkpoint between the origin and the destination (the pins stand for those two)", () => {
    const base = route();
    const [first, second] = base.checkpoints;
    if (!first || !second) throw new Error("the minimal route has two checkpoints");
    const middle = {
      ...second,
      index: 1,
      lat: 40.5,
      lon: -110.5,
      risk: { ...second.risk, level: "severe" as const },
    };
    const unknown = {
      ...second,
      index: 2,
      lat: 40.2,
      lon: -110.2,
      risk: { ...second.risk, level: null },
    };
    const last = { ...second, index: 3 };
    const a = route({ route_id: "A", checkpoints: [first, middle, unknown, last] });
    const b = route({ route_id: "B", checkpoints: [first, { ...middle }, last] });

    const collection = buildCheckpointCollection(planWith([a, b]), label);

    expect(collection.features).toEqual([
      {
        type: "Feature",
        id: checkpointFeatureId(0, 1),
        geometry: { type: "Point", coordinates: [-110.5, 40.5] },
        properties: { route_id: "A", index: 1, level: "severe", ordinal: 3, eta: "T1" },
      },
      {
        type: "Feature",
        id: checkpointFeatureId(0, 2),
        geometry: { type: "Point", coordinates: [-110.2, 40.2] },
        properties: { route_id: "A", index: 2, level: "unknown", ordinal: -1, eta: "T2" },
      },
      {
        type: "Feature",
        id: checkpointFeatureId(1, 1),
        geometry: { type: "Point", coordinates: [-110.5, 40.5] },
        properties: { route_id: "B", index: 1, level: "severe", ordinal: 3, eta: "T1" },
      },
    ]);
  });

  it("has no markers for a route with only its two endpoints", () => {
    expect(buildCheckpointCollection(planWith([route()]), label).features).toEqual([]);
  });
});

describe("routeBounds", () => {
  it("is the extent of every route together, as [west, south, east, north]", () => {
    const a = route({
      geometry: {
        type: "LineString",
        coordinates: [
          [-112, 40],
          [-110, 41],
        ],
      },
    });
    const b = route({
      geometry: {
        type: "LineString",
        coordinates: [
          [-111, 39],
          [-104, 40],
        ],
      },
    });

    expect(routeBounds(planWith([a, b]))).toEqual([-112, 39, -104, 41]);
  });
});
