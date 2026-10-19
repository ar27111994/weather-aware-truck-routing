import { describe, expect, it } from "vitest";

import { cx } from "./cx";

describe("cx", () => {
  it("joins class names with single spaces", () => {
    expect(cx("a", "b", "c")).toBe("a b c");
  });

  it("skips undefined, null, false and empty strings", () => {
    expect(cx("a", undefined, null, false, "", "b")).toBe("a b");
  });

  it("returns an empty string when nothing is left", () => {
    expect(cx()).toBe("");
    expect(cx(false, undefined)).toBe("");
  });
});
