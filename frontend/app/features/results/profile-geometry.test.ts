import { describe, expect, it } from "vitest";

import { at } from "../../lib/checked";
import { planFor } from "../../../test/plans";
import { PROFILE_SIZE, layoutProfile, tickSpacing } from "./profile-geometry";

const route = at(planFor("mixed").routes, 0);

describe("tickSpacing", () => {
  const plotWidth = PROFILE_SIZE.width - 76 - 12;

  it("is 50 miles for routes up to 400 miles, and 100 miles while 3-digit labels fit", () => {
    expect(tickSpacing(0)).toBe(50);
    expect(tickSpacing(400)).toBe(50);
    expect(tickSpacing(400.1)).toBe(100);
    expect(tickSpacing(900)).toBe(100);
  });

  // R4-12: a label every 100 miles was 25 view-box units apart at 1,000 miles and 8 at 3,000, where
  // a 4-digit label at 12 px is about 29 units wide, so the labels overlapped. The API plans routes
  // up to 3,000 miles.
  it("widens the spacing with the length of the route", () => {
    expect(tickSpacing(1_016)).toBe(200);
    expect(tickSpacing(3_000)).toBe(500);
  });

  it("leaves every label the room of its digits, for any length the API plans", () => {
    for (let miles = 1; miles <= 3_000; miles += 1) {
      const widest = String(miles).length * 7.2;
      const apart = (plotWidth * tickSpacing(miles)) / miles;
      expect(apart, `${String(miles)} mi`).toBeGreaterThanOrEqual(widest);
    }
  });

  it("never puts a tick past the destination", () => {
    for (const miles of [401, 1_016, 2_999]) {
      const { ticks } = layoutProfile({ ...route, distance_mi: miles });
      expect(Math.max(...ticks.map((tick) => tick.miles))).toBeLessThanOrEqual(miles);
    }
  });
});

describe("layoutProfile", () => {
  const layout = layoutProfile(route);

  it("draws in the 340 by 200 chart box", () => {
    expect([layout.width, layout.height]).toEqual([PROFILE_SIZE.width, PROFILE_SIZE.height]);
    expect(layout.left).toBeLessThan(layout.right);
    expect(layout.top).toBeLessThan(layout.bottom);
  });

  it("stacks the bands from No Travel at the top to Unknown at the bottom", () => {
    expect(layout.rows.map((row) => row.level)).toEqual([
      "no_travel",
      "severe",
      "high",
      "moderate",
      "low",
      null,
    ]);
    const ys = layout.rows.map((row) => row.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it("puts every checkpoint at its distance, the origin at the left edge and the destination at the right", () => {
    const [first] = layout.points;
    const final = at(layout.points, layout.points.length - 1);

    expect(layout.points).toHaveLength(route.checkpoints.length);
    expect(first?.x).toBe(layout.left);
    expect(final.x).toBeCloseTo(layout.right, 6);
    const xs = layout.points.map((point) => point.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it("puts each point on the row of its level, and an unknown level on the Unknown row", () => {
    const unknownRow = at(layout.rows, layout.rows.length - 1).y;
    const blind = {
      ...route,
      checkpoints: route.checkpoints.map((checkpoint, index) =>
        index === 1 ? { ...checkpoint, risk: { ...checkpoint.risk, level: null } } : checkpoint,
      ),
    };

    const shaped = layoutProfile(blind);

    expect(at(shaped.points, 1).y).toBe(unknownRow);
    for (const point of layout.points) {
      expect(layout.rows.find((row) => row.level === point.level)?.y).toBe(point.y);
    }
  });

  it("joins the points with a step line that holds each level until the next checkpoint", () => {
    const [first, second] = layout.points;
    if (first === undefined || second === undefined) throw new Error("fewer than two points");

    expect(
      layout.path.startsWith(
        `M ${first.x.toFixed(2)} ${first.y.toFixed(2)} H ${second.x.toFixed(2)} V ${second.y.toFixed(2)}`,
      ),
    ).toBe(true);
    expect(layout.path.match(/H/gu)).toHaveLength(layout.points.length - 1);
  });

  it("puts a tick at every 50 or 100 miles from the origin", () => {
    const spacing = tickSpacing(route.distance_mi);

    expect(layout.ticks.map((tick) => tick.miles)).toEqual(
      Array.from({ length: Math.floor(route.distance_mi / spacing) + 1 }, (_, n) => n * spacing),
    );
    expect(at(layout.ticks, 0).x).toBe(layout.left);
  });

  it("draws nothing for a route with no checkpoints", () => {
    expect(layoutProfile({ ...route, checkpoints: [] }).path).toBe("");
  });

  it("puts everything at the start for a route of no length instead of dividing by zero", () => {
    const flat = layoutProfile({ ...route, distance_mi: 0 });

    expect(flat.points.every((point) => point.x === flat.left)).toBe(true);
    expect(flat.ticks).toEqual([{ miles: 0, x: flat.left }]);
  });
});
