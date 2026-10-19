import { describe, expect, it } from "vitest";

import {
  FLING_VELOCITY,
  VELOCITY_WINDOW,
  beginDrag,
  cycleSnap,
  directionBetween,
  dragBy,
  dragHeight,
  dragShift,
  nearestSnap,
  releaseSnap,
  releaseVelocity,
  resolveSnapHeights,
  snapForRelease,
  stepSnap,
  type PointerSample,
  type SheetDirection,
  type SheetSnap,
  type SnapHeights,
} from "./sheetGeometry";

/** An 800 px viewport with the 112 px peek and 56 px header gap: peek 112, half 400, full 744. */
const heights: SnapHeights = { peek: 112, half: 400, full: 744 };

describe("resolveSnapHeights", () => {
  it.each<[string, number, number, number, SnapHeights]>([
    ["a phone portrait viewport", 800, 112, 56, { peek: 112, half: 400, full: 744 }],
    [
      "a peek that includes the home-indicator inset",
      800,
      146,
      56,
      { peek: 146, half: 400, full: 744 },
    ],
    ["a phone landscape viewport", 360, 112, 56, { peek: 112, half: 180, full: 304 }],
    [
      "a 400% zoom viewport where half would sit under peek",
      180,
      112,
      56,
      { peek: 112, half: 112, full: 124 },
    ],
    ["a viewport shorter than the peek", 100, 112, 56, { peek: 112, half: 112, full: 112 }],
  ])("resolves %s", (_name, viewport, peek, gap, expected) => {
    expect(resolveSnapHeights(viewport, peek, gap)).toEqual(expected);
  });
});

describe("nearestSnap", () => {
  it.each<[number, SheetSnap]>([
    [50, "peek"],
    [112, "peek"],
    [255, "peek"],
    [256, "peek"],
    [257, "half"],
    [400, "half"],
    [572, "half"],
    [573, "full"],
    [744, "full"],
    [900, "full"],
  ])("maps a visible height of %s px to %s", (height, expected) => {
    expect(nearestSnap(height, heights)).toBe(expected);
  });
});

describe("snapForRelease", () => {
  it.each<[string, number, number, SheetSnap]>([
    ["a slow release near the top", 600, 0, "full"],
    ["a slow release near the middle", 300, 0, "half"],
    ["a slow release near the bottom", 200, 0, "peek"],
    ["upward speed exactly at the threshold is not a fling", 430, -FLING_VELOCITY, "half"],
    ["downward speed exactly at the threshold is not a fling", 300, FLING_VELOCITY, "half"],
    ["an upward fling from just above half goes to full", 430, -0.51, "full"],
    ["an upward fling from the bottom goes to half", 130, -1, "half"],
    ["an upward fling from exactly peek goes to half", 112, -1, "half"],
    ["an upward fling from within a pixel of half goes to full", 399.5, -1, "full"],
    ["an upward fling from clearly under half goes to half", 398, -1, "half"],
    ["an upward fling at full stays full", 744, -2, "full"],
    ["a downward fling from near full goes to half", 700, 1, "half"],
    ["a downward fling from exactly half goes to peek", 400, 1, "peek"],
    ["a downward fling from within a pixel of half goes to peek", 400.5, 1, "peek"],
    ["a downward fling from clearly above half goes to half", 402, 1, "half"],
    ["a downward fling at peek stays peek", 112, 2, "peek"],
    ["a downward fling from just under half goes to peek", 380, 0.9, "peek"],
  ])("%s", (_name, height, velocity, expected) => {
    expect(snapForRelease(height, velocity, heights)).toBe(expected);
  });
});

describe("stepSnap", () => {
  it.each<[SheetSnap, SheetDirection, SheetSnap]>([
    ["peek", "up", "half"],
    ["half", "up", "full"],
    ["full", "up", "full"],
    ["full", "down", "half"],
    ["half", "down", "peek"],
    ["peek", "down", "peek"],
  ])("steps %s %s to %s", (snap, direction, expected) => {
    expect(stepSnap(snap, direction)).toBe(expected);
  });
});

describe("cycleSnap", () => {
  it.each<[SheetSnap, SheetDirection, SheetSnap]>([
    ["peek", "up", "half"],
    ["peek", "down", "half"],
    ["half", "up", "full"],
    ["half", "down", "peek"],
    ["full", "up", "half"],
    ["full", "down", "half"],
  ])("cycles %s heading %s to %s", (snap, direction, expected) => {
    expect(cycleSnap(snap, direction)).toBe(expected);
  });

  it("walks peek, half, full, half, peek when the heading is kept between taps", () => {
    const visited: SheetSnap[] = [];
    let snap: SheetSnap = "peek";
    let direction: SheetDirection = "up";
    for (let tap = 0; tap < 5; tap += 1) {
      const next = cycleSnap(snap, direction);
      direction = directionBetween(snap, next);
      snap = next;
      visited.push(snap);
    }

    expect(visited).toEqual(["half", "full", "half", "peek", "half"]);
  });
});

describe("directionBetween", () => {
  it.each<[SheetSnap, SheetSnap, SheetDirection]>([
    ["peek", "half", "up"],
    ["peek", "full", "up"],
    ["half", "full", "up"],
    ["full", "half", "down"],
    ["half", "peek", "down"],
    ["full", "peek", "down"],
  ])("heads from %s to %s as %s", (from, to, expected) => {
    expect(directionBetween(from, to)).toBe(expected);
  });
});

describe("releaseVelocity", () => {
  const sample = (time: number, travel: number): PointerSample => ({ time, travel });

  it.each<[string, readonly PointerSample[], number, number]>([
    ["no samples", [], 0, 0],
    ["a single sample", [sample(0, -10)], 0, 0],
    ["two samples at the same instant", [sample(5, 0), sample(5, -10)], 5, 0],
    ["a quick upward move", [sample(0, 0), sample(10, -20)], 10, -2],
    ["a quick downward move", [sample(0, 0), sample(10, 5)], 12, 0.5],
    [
      "a finger that rested before lifting",
      [sample(0, 0), sample(10, -20)],
      10 + VELOCITY_WINDOW + 1,
      0,
    ],
    [
      "only the samples inside the window",
      [sample(0, 0), sample(150, -100), sample(160, -120)],
      160,
      -2,
    ],
  ])("measures %s", (_name, samples, releaseTime, expected) => {
    expect(releaseVelocity(samples, releaseTime)).toBeCloseTo(expected);
  });
});

describe("drag session", () => {
  it("starts at the resting height of the snap with no travel", () => {
    const session = beginDrag("half", heights);

    expect(dragHeight(session)).toBe(400);
    expect(dragShift(session)).toBe(0);
  });

  it.each<[string, number, number, number]>([
    ["following the finger up", -100, 500, -100],
    ["following the finger down", 50, 350, 50],
    ["clamping at full", -1000, 744, -344],
    ["clamping at peek", 1000, 112, 288],
  ])("%s", (_name, travel, expectedHeight, expectedShift) => {
    const session = dragBy(beginDrag("half", heights), travel, 0);

    expect(dragHeight(session)).toBe(expectedHeight);
    expect(dragShift(session)).toBe(expectedShift);
  });

  it("only moves back once the finger is back inside the limit", () => {
    let session = beginDrag("half", heights);
    session = dragBy(session, -500, 0);
    session = dragBy(session, 100, 10);

    expect(dragHeight(session)).toBe(744);
    session = dragBy(session, 100, 20);
    expect(dragHeight(session)).toBe(700);
  });

  it("keeps only the samples inside the velocity window", () => {
    let session = beginDrag("half", heights);
    session = dragBy(session, -5, 0);
    session = dragBy(session, -5, 50);
    session = dragBy(session, -5, 160);

    expect(session.samples.map((entry) => entry.time)).toEqual([160]);
    session = dragBy(session, -5, 200);
    expect(session.samples.map((entry) => entry.time)).toEqual([160, 200]);
  });

  it("releases to the nearest snap when moving slowly", () => {
    let session = beginDrag("half", heights);
    session = dragBy(session, -250, 0);

    expect(releaseSnap(session, 1000, "half")).toBe("full");
  });

  it("flings to the next snap in the direction of travel", () => {
    let session = beginDrag("half", heights);
    session = dragBy(session, -10, 0);
    session = dragBy(session, -10, 10);

    expect(releaseSnap(session, 12, "half")).toBe("full");
  });

  it("keeps the current snap when there is no drag to release", () => {
    expect(releaseSnap(null, 100, "peek")).toBe("peek");
  });
});
