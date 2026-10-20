import { describe, expect, it } from "vitest";

import { tokens } from "../../tokens/tokens";
import { SCALE } from "./TimelineSlider";

/** `"34px"` is 34. */
function pixels(value: string | number): number {
  return Number.parseFloat(String(value));
}

// The scale is an SVG, and SVG attributes cannot read a custom property, so `SCALE` repeats the
// component tokens as numbers. These tests are what keeps the two in step (R1-11).
describe("the timeline scale's SVG geometry", () => {
  it.each([
    ["dayLabelY", "c-slider-scale-day-label-y"],
    ["dayRuleTop", "c-slider-scale-day-rule-top"],
    ["daysHeight", "c-slider-scale-days-height"],
    ["tickLength", "c-slider-scale-tick-length"],
    ["tickLengthMajor", "c-slider-scale-tick-length-major"],
    ["tickLabelY", "c-slider-scale-tick-label-y"],
  ] as const)("%s is --%s in both themes", (key, token) => {
    expect(SCALE[key]).toBe(pixels(tokens.light[token]));
    expect(SCALE[key]).toBe(pixels(tokens.dark[token]));
  });
});
