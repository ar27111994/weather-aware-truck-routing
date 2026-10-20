import { describe, expect, it } from "vitest";

import { tokens } from "../../tokens/tokens";
import { TOOLTIP_OFFSET } from "./Tooltip";

// The positioning API takes a number, not a custom property, so the component repeats the token.
describe("the tooltip's offset", () => {
  it("is --c-tooltip-offset in both themes", () => {
    expect(TOOLTIP_OFFSET).toBe(Number.parseFloat(tokens.light["c-tooltip-offset"]));
    expect(TOOLTIP_OFFSET).toBe(Number.parseFloat(tokens.dark["c-tooltip-offset"]));
  });
});
