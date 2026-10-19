import { describe, expect, it } from "vitest";

import { at } from "./checked";

describe("at", () => {
  it("returns the element at a valid index", () => {
    expect(at(["a", "b", "c"], 0)).toBe("a");
    expect(at(["a", "b", "c"], 2)).toBe("c");
  });

  it("throws a RangeError naming the index when it is out of range", () => {
    expect(() => at([1, 2], 2)).toThrow(new RangeError("Index 2 is out of range (length 2)"));
    expect(() => at([], 0)).toThrow(RangeError);
  });

  it("rejects negative indices instead of wrapping around like Array.prototype.at", () => {
    expect(() => at([1, 2, 3], -1)).toThrow(RangeError);
  });

  it("rejects fractional and NaN indices", () => {
    expect(() => at([1, 2, 3], 1.5)).toThrow(RangeError);
    expect(() => at([1, 2, 3], Number.NaN)).toThrow(RangeError);
  });
});
