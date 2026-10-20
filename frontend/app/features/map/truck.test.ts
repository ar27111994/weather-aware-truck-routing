import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Plan, Route } from "../../api/contract";
import { minimalPlan } from "../../api/mocks";
import { frameElapsedSeconds, truckPositions } from "./truck";

const HOUR_MS = 3_600_000;

function planWith(routes: readonly Partial<Route>[]): Plan {
  const plan = minimalPlan();
  const [base] = plan.routes;
  if (!base) throw new Error("the minimal plan has a route");
  return { ...plan, routes: routes.map((overrides) => ({ ...base, ...overrides })) };
}

describe("frameElapsedSeconds", () => {
  it("measures a frame from the route's departure, not from the floored start of the heatmap", () => {
    const start = Date.parse("2026-10-20T14:00:00Z");
    const departure = Date.parse("2026-10-20T14:20:00Z");

    expect(frameElapsedSeconds(start, departure, 0)).toBe(-1200);
    expect(frameElapsedSeconds(start, departure, 2)).toBe(2 * 3600 - 1200);
  });
});

describe("truckPositions", () => {
  const plan = planWith([
    {
      route_id: "A",
      departure_time: "2026-10-20T14:00:00Z",
      geometry: {
        type: "LineString",
        coordinates: [
          [-112, 40],
          [-111, 40],
          [-110, 40],
        ],
      },
      cumulative_s: [0, 3600, 7200],
    },
    {
      route_id: "B",
      departure_time: "2026-10-20T14:00:00Z",
      geometry: {
        type: "LineString",
        coordinates: [
          [-112, 41],
          [-110, 41],
        ],
      },
      cumulative_mi: [0, 50],
      cumulative_s: [0, 14_400],
    },
  ]);
  const start = Date.parse("2026-10-20T14:00:00Z");

  it("places each route's truck where its schedule puts it at the frame's time", () => {
    expect(truckPositions(plan, start, 1)).toEqual([
      { routeId: "A", position: [-111, 40] },
      { routeId: "B", position: [-111.5, 41] },
    ]);
  });

  it("hides a truck that has arrived, and keeps the others moving", () => {
    expect(truckPositions(plan, start, 3)).toEqual([
      { routeId: "A", position: null },
      { routeId: "B", position: [-110.5, 41] },
    ]);
  });

  it("hides every truck before departure", () => {
    expect(truckPositions(plan, start - HOUR_MS, 0).map((truck) => truck.position)).toEqual([
      null,
      null,
    ]);
  });

  it("moves monotonically east along an eastbound route as the frames advance (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 47 }), (frame) => {
        const [now] = truckPositions(plan, start, frame);
        const [later] = truckPositions(plan, start, frame + 1);
        if (now?.position && later?.position) {
          expect(later.position[0]).toBeGreaterThanOrEqual(now.position[0]);
        }
      }),
    );
  });
});
