import { describe, expect, it } from "vitest";

import { selectedRouteId } from "./selection";

describe("selectedRouteId", () => {
  it("is the id of the one selected route", () => {
    expect(selectedRouteId(new Set(["B"]))).toBe("B");
  });

  it("writes a numeric key as text, so an id is always a string", () => {
    expect(selectedRouteId(new Set([2]))).toBe("2");
  });

  it("is no route for an empty selection", () => {
    expect(selectedRouteId(new Set())).toBeNull();
  });

  it('is no route for "all": a single-selection list never selects everything', () => {
    expect(selectedRouteId("all")).toBeNull();
  });
});
