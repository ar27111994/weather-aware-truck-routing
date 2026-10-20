import { describe, expect, it } from "vitest";

import { minimalPlan } from "../../api/mocks";
import { at } from "../../lib/checked";
import { createEtaLabel } from "./eta";

const checkpoint = {
  ...at(at(minimalPlan().routes, 0).checkpoints, 0),
  eta: "2026-10-20T20:20:00Z",
  utc_offset_s: -21_600,
};

describe("createEtaLabel (D-16)", () => {
  it("writes the ETA on the checkpoint's own clock, 12-hour in en-US", () => {
    expect(createEtaLabel("en-US")(checkpoint)).toBe("2:20 PM");
  });

  it("follows the locale's hour cycle: 24-hour in en-GB", () => {
    expect(createEtaLabel("en-GB")(checkpoint)).toBe("14:20");
  });

  it("does not depend on the host time zone (the offset sets the clock)", () => {
    expect(createEtaLabel("en-US")({ ...checkpoint, utc_offset_s: 19_800 })).toBe("1:50 AM");
  });
});
