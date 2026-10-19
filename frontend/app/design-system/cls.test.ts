import { describe, expect, it } from "vitest";

import { cls } from "./cls";

describe("cls", () => {
  it("joins class names with single spaces", () => {
    expect(cls("a", "b", "c")).toBe("a b c");
  });

  it("skips undefined, null, false and empty values", () => {
    expect(cls("a", undefined, null, false, "", "b")).toBe("a b");
  });

  it("returns an empty string when nothing is left", () => {
    expect(cls(undefined, false)).toBe("");
  });
});
