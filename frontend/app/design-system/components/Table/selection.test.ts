import { describe, expect, it } from "vitest";

import { keyToSelection, selectionToKey } from "./selection";

describe("selectionToKey", () => {
  it("returns the one selected key", () => {
    expect(selectionToKey(new Set(["cp-3"]))).toBe("cp-3");
  });

  it("returns null when nothing is selected", () => {
    expect(selectionToKey(new Set())).toBeNull();
  });

  it("returns null for the select-all marker, which a single-selection table never produces", () => {
    expect(selectionToKey("all")).toBeNull();
  });

  it("returns a string even if React Aria hands over a numeric key", () => {
    expect(selectionToKey(new Set([7]))).toBe("7");
  });
});

describe("keyToSelection", () => {
  it("leaves the selection to React Aria when no key is controlled", () => {
    expect(keyToSelection(undefined)).toBeUndefined();
  });

  it("is an empty selection for null", () => {
    expect(keyToSelection(null)).toEqual(new Set());
  });

  it("is a one-key selection for a key", () => {
    expect(keyToSelection("cp-3")).toEqual(new Set(["cp-3"]));
  });
});
