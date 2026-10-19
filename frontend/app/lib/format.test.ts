import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  formatDuration,
  formatDurationDelta,
  formatFahrenheit,
  formatHoursFromDeparture,
  formatInchesPerHour,
  formatLocalTime,
  formatMiles,
  formatMph,
  formatPounds,
  formatUtcOffset,
} from "./format";

const MINUS = "\u2212";
/** Intl puts a narrow no-break space before AM/PM; compare with plain spaces. */
const plain = (text: string): string => text.replace(/\s/g, " ");

describe("formatMiles", () => {
  it("always shows one decimal, with grouping and the unit", () => {
    expect(formatMiles(537.0552)).toBe("537.1 mi");
    expect(formatMiles(1016.4)).toBe("1,016.4 mi");
    expect(formatMiles(0)).toBe("0.0 mi");
    expect(formatMiles(-0)).toBe("0.0 mi");
  });

  it("can omit the unit and follows the locale", () => {
    expect(formatMiles(12.34, { unit: false })).toBe("12.3");
    expect(formatMiles(1016.4, { locale: "de-DE" })).toBe("1.016,4 mi");
  });

  it.each([[-1], [Number.NaN], [Number.POSITIVE_INFINITY]])("rejects %f", (value) => {
    expect(() => formatMiles(value)).toThrow(RangeError);
  });

  it("round-trips to within 0.05 mi (property)", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 5000, noNaN: true }), (miles) => {
        const parsed = Number(formatMiles(miles, { unit: false }).replaceAll(",", ""));
        expect(Math.abs(parsed - miles)).toBeLessThanOrEqual(0.05 + 1e-9);
      }),
    );
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0 min"],
    [29, "0 min"],
    [30, "1 min"],
    [2280, "38 min"],
    [3600, "1 h"],
    [28666, "7 h 58 min"],
    [27840, "7 h 44 min"],
    [28800, "8 h"],
    [360_000, "100 h"],
    [3_600_000, "1,000 h"],
  ])("%d s is %s", (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });

  it.each([[-1], [Number.NaN], [Number.POSITIVE_INFINITY]])("rejects %f", (value) => {
    expect(() => formatDuration(value)).toThrow(RangeError);
  });

  it("never throws for finite non-negative input and keeps minutes under 60 (property)", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e9, noNaN: true }), (seconds) => {
        const minutes = /(\d+) min$/.exec(formatDuration(seconds));
        expect(minutes === null || Number(minutes[1]) < 60).toBe(true);
      }),
    );
  });
});

describe("formatDurationDelta", () => {
  it("signs comparisons, using the real minus sign", () => {
    expect(formatDurationDelta(1377)).toBe("+23 min");
    expect(formatDurationDelta(-3900)).toBe(`${MINUS}1 h 5 min`);
  });

  it("has no sign when the difference rounds to zero", () => {
    expect(formatDurationDelta(0)).toBe("0 min");
    expect(formatDurationDelta(-20)).toBe("0 min");
  });

  it.each([[Number.NaN], [Number.NEGATIVE_INFINITY]])("rejects %f", (value) => {
    expect(() => formatDurationDelta(value)).toThrow(RangeError);
  });

  it("differs from its negation only in the sign (property)", () => {
    fc.assert(
      fc.property(fc.double({ min: 120, max: 1e6, noNaN: true }), (seconds) => {
        expect(formatDurationDelta(seconds).slice(1)).toBe(formatDurationDelta(-seconds).slice(1));
      }),
    );
  });
});

describe("formatPounds, formatMph, formatInchesPerHour, formatFahrenheit", () => {
  it("formats loads with separators and rounds fractions", () => {
    expect(formatPounds(38000)).toBe("38,000 lb");
    expect(formatPounds(0)).toBe("0 lb");
    expect(formatPounds(80000.4)).toBe("80,000 lb");
    expect(formatPounds(38000, { locale: "de-DE" })).toBe("38.000 lb");
  });

  it("formats wind speed to one decimal", () => {
    expect(formatMph(12.34)).toBe("12.3 mph");
    expect(formatMph(0)).toBe("0.0 mph");
  });

  it("formats precipitation with two to three decimals", () => {
    expect(formatInchesPerHour(0)).toBe("0.00 in/hr");
    expect(formatInchesPerHour(0.1)).toBe("0.10 in/hr");
    expect(formatInchesPerHour(0.125)).toBe("0.125 in/hr");
    expect(formatInchesPerHour(0.12345)).toBe("0.123 in/hr");
  });

  it("formats temperature to whole degrees and allows negatives", () => {
    expect(formatFahrenheit(48.2)).toBe("48\u00b0F");
    expect(formatFahrenheit(-10.4)).toBe("-10\u00b0F");
    expect(formatFahrenheit(-0.4)).toBe("0\u00b0F");
  });

  it("rejects negative or non-finite quantities, and non-finite temperatures", () => {
    expect(() => formatPounds(-1)).toThrow(RangeError);
    expect(() => formatMph(Number.NaN)).toThrow(RangeError);
    expect(() => formatInchesPerHour(-0.01)).toThrow(RangeError);
    expect(() => formatFahrenheit(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("formatHoursFromDeparture", () => {
  it("shows an explicit sign", () => {
    expect(formatHoursFromDeparture(6)).toBe("+6 h");
    expect(formatHoursFromDeparture(0)).toBe("+0 h");
    expect(formatHoursFromDeparture(48)).toBe("+48 h");
    expect(formatHoursFromDeparture(-3)).toBe(`${MINUS}3 h`);
  });

  it("rejects fractions and non-finite values", () => {
    expect(() => formatHoursFromDeparture(1.5)).toThrow(RangeError);
    expect(() => formatHoursFromDeparture(Number.NaN)).toThrow(RangeError);
  });

  it("always starts with a sign (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: -100, max: 100 }), (hours) => {
        expect(["+", MINUS]).toContain(formatHoursFromDeparture(hours)[0]);
      }),
    );
  });
});

describe("formatUtcOffset", () => {
  it.each([
    [-21600, `UTC${MINUS}6`],
    [19800, "UTC+5:30"],
    [0, "UTC+0"],
    [-12600, `UTC${MINUS}3:30`],
    [3600 * 18, "UTC+18"],
  ])("%d s is %s", (seconds, text) => {
    expect(formatUtcOffset(seconds)).toBe(text);
  });

  it.each([[30], [3600 * 19], [Number.NaN]])("rejects %f", (value) => {
    expect(() => formatUtcOffset(value)).toThrow(RangeError);
  });
});

describe("formatLocalTime", () => {
  const denver = { timezone: "America/Denver", utc_offset_s: -21600 };

  it("shows the weekday, wall-clock time and zone abbreviation", () => {
    expect(plain(formatLocalTime("2026-10-20T14:00:00Z", denver))).toBe("Tue 8:00 AM MDT");
  });

  it("can drop the weekday", () => {
    expect(plain(formatLocalTime("2026-10-20T14:00:00Z", denver, { weekday: false }))).toBe(
      "8:00 AM MDT",
    );
  });

  it("computes the clock from the offset, so it is independent of the host tz database", () => {
    const fixed = { timezone: "America/Denver", utc_offset_s: -25200 };
    expect(plain(formatLocalTime("2026-10-20T14:00:00Z", fixed, { weekday: false }))).toContain(
      "7:00 AM",
    );
  });

  it("rolls over midnight and the date line", () => {
    const india = { timezone: "Asia/Kolkata", utc_offset_s: 19800 };
    expect(plain(formatLocalTime("2026-10-20T23:30:00Z", india))).toBe("Wed 5:00 AM UTC+5:30");
    expect(plain(formatLocalTime("2026-10-20T07:00:00Z", denver, { weekday: false }))).toContain(
      "1:00 AM",
    );
    expect(plain(formatLocalTime("2026-10-20T06:00:00Z", denver, { weekday: false }))).toContain(
      "12:00 AM",
    );
    expect(plain(formatLocalTime("2026-10-20T18:00:00Z", denver, { weekday: false }))).toContain(
      "12:00 PM",
    );
  });

  it("falls back to a UTC offset label for an unknown time zone", () => {
    const unknown = { timezone: "Not/AZone", utc_offset_s: -21600 };
    expect(plain(formatLocalTime("2026-10-20T14:00:00Z", unknown))).toBe(
      `Tue 8:00 AM UTC${MINUS}6`,
    );
  });

  it("falls back to a UTC offset label when Intl only knows a bare GMT offset", () => {
    const brazil = { timezone: "America/Sao_Paulo", utc_offset_s: -10800 };
    expect(plain(formatLocalTime("2026-10-20T14:00:00Z", brazil))).toBe(
      `Tue 11:00 AM UTC${MINUS}3`,
    );
  });

  it("follows the requested locale", () => {
    expect(
      plain(formatLocalTime("2026-10-20T14:00:00Z", denver, { locale: "de-DE", weekday: false })),
    ).toBe("8:00 UTC−6");
  });

  it("rejects an invalid timestamp", () => {
    expect(() => formatLocalTime("yesterday", denver)).toThrow(RangeError);
  });
});
