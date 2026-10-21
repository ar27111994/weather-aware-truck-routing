import { describe, expect, it } from "vitest";

import { SAMPLING_INTERVALS_MI } from "../../api/contract";
import { DEFAULT_SAMPLING_INTERVAL_MI } from "../../lib/risk";
import { intervalFromValue } from "./intervals";

describe("intervalFromValue", () => {
  it("is the interval each segmented value names", () => {
    for (const interval of SAMPLING_INTERVALS_MI) {
      expect(intervalFromValue(String(interval))).toBe(interval);
    }
  });

  it("is the default for a value that names none", () => {
    expect(intervalFromValue("15")).toBe(DEFAULT_SAMPLING_INTERVAL_MI);
    expect(intervalFromValue("")).toBe(DEFAULT_SAMPLING_INTERVAL_MI);
  });
});
