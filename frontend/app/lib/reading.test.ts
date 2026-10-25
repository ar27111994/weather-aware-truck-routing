import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { formatReading } from "./reading";
import type { WeatherReading } from "./reading";

const MINUS = "\u2212";

describe("formatReading (DESIGN.md section 2: one digit rule per weather quantity)", () => {
  const READINGS: readonly WeatherReading[] = ["wind", "gust", "rain", "snow", "temp"];

  it.each([
    ["wind", 12.34, "12.3"],
    ["gust", 21, "21.0"],
    ["rain", 0.1, "0.100"],
    ["snow", 0.2504, "0.250"],
    ["temp", 48.2, "48.2"],
  ] as const)("shows %s %f as %s", (reading, value, text) => {
    expect(formatReading(value, reading)).toBe(text);
  });

  it("gives rain and snow exactly three decimals and temperature exactly one", () => {
    expect(formatReading(0, "rain")).toBe("0.000");
    expect(formatReading(0.0004, "snow")).toBe("0.000");
    expect(formatReading(0.2496, "rain")).toBe("0.250");
    expect(formatReading(41, "temp")).toBe("41.0");
  });

  it("tells 31.6 and 32.4 apart, either side of the freezing line", () => {
    expect(formatReading(31.6, "temp")).toBe("31.6");
    expect(formatReading(32.4, "temp")).toBe("32.4");
  });

  it("writes a negative number with U+2212, never a hyphen-minus", () => {
    const text = formatReading(-3.6, "temp");

    expect(text).toBe(`${MINUS}3.6`);
    expect(text.codePointAt(0)).toBe(0x2212);
    expect(text.includes("-")).toBe(false);
    expect(formatReading(-0.4, "temp")).toBe(`${MINUS}0.4`);
    expect(formatReading(-0.05, "temp")).toBe(`${MINUS}0.1`);
  });

  it("writes no sign for a value that rounds to zero", () => {
    expect(formatReading(-0.04, "temp")).toBe("0.0");
    expect(formatReading(-0, "temp")).toBe("0.0");
    expect(formatReading(-0.0004, "rain")).toBe("0.000");
  });

  it("follows the locale's separators, and writes U+2212 even where the locale writes a hyphen", () => {
    expect(formatReading(-3.5, "temp", { locale: "de-DE" })).toBe(`${MINUS}3,5`);
    expect(formatReading(0.62, "rain", { locale: "de-DE" })).toBe("0,620");
    // Swedish already writes U+2212 itself: the rule must not double it.
    expect(formatReading(-3.5, "temp", { locale: "sv-SE" })).toBe(`${MINUS}3,5`);
  });

  it("rejects a value that is not finite", () => {
    expect(() => formatReading(Number.NaN, "wind")).toThrow(RangeError);
    expect(() => formatReading(Number.POSITIVE_INFINITY, "temp")).toThrow(RangeError);
    expect(() => formatReading(Number.NEGATIVE_INFINITY, "rain")).toThrow(RangeError);
  });

  it("starts with U+2212 exactly when the number it shows is below zero (property)", () => {
    // Magnitudes from 0.00001 to 0.6, so a good share of the draws round to zero at one decimal
    // and some at three.
    fc.assert(
      fc.property(
        fc.constantFrom(...READINGS),
        fc.constantFrom(1e-5, 1e-4, 1e-3, 1e-2),
        fc.integer({ min: -60, max: 60 }),
        (reading, step, count) => {
          const text = formatReading(count * step, reading);

          expect(text.includes("-")).toBe(false);
          expect(text.startsWith(MINUS)).toBe(Number(text.replace(MINUS, "-")) < 0);
        },
      ),
    );
  });
});
