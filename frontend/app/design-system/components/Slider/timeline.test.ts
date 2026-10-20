import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { DENVER, DEPARTURE } from "../../../../test/timeline-clock";
import { createTimelineFormatters, describeTimelineValue, timelineMarks } from "./timeline";
import type { TimelineClock } from "./timeline";

/** Marks for a clock, with the formatters built for this one call. */
function marksOf(clock: TimelineClock, totalHours: number): ReturnType<typeof timelineMarks> {
  return timelineMarks(createTimelineFormatters(clock), totalHours);
}

/** One reading for a clock, with the formatters built for this one call. */
function readingOf(clock: TimelineClock, hour: number): ReturnType<typeof describeTimelineValue> {
  return describeTimelineValue(createTimelineFormatters(clock), hour);
}

describe("timelineMarks", () => {
  it("has a mark for every whole hour from 0 to the end", () => {
    const { hours } = marksOf(DENVER, 48);

    expect(hours).toHaveLength(49);
    expect(hours[0]).toBe(0);
    expect(hours.at(-1)).toBe(48);
  });

  it("labels every sixth hour after 0 and never +0", () => {
    const { labels } = marksOf(DENVER, 48);

    expect(labels.map((label) => label.hour)).toEqual([6, 12, 18, 24, 30, 36, 42, 48]);
    expect(labels.map((label) => label.text).slice(0, 2)).toEqual(["+6 h", "+12 h"]);
  });

  it("finds local midnights and names the day that starts there", () => {
    const { days } = marksOf(DENVER, 48);

    expect(days).toEqual([
      { hour: 10, weekday: "Wed" },
      { hour: 34, weekday: "Thu" },
    ]);
  });

  it("finds a fractional midnight when the departure is not on the hour", () => {
    const { days } = marksOf({ ...DENVER, departure: DEPARTURE + 20 * 60_000 }, 48);

    expect(days[0]?.hour).toBeCloseTo(10 - 20 / 60, 6);
  });

  it("puts a midnight exactly on the hour at that hour", () => {
    const midnight = Date.UTC(2026, 9, 21, 6, 0, 0);
    const { days } = marksOf({ ...DENVER, departure: midnight - 5 * 3_600_000 }, 12);

    expect(days).toEqual([{ hour: 5, weekday: "Wed" }]);
  });

  it("finds no midnight in a short timeline that stays within one day", () => {
    expect(marksOf(DENVER, 6).days).toEqual([]);
  });

  it("uses the runtime zone and locale when none are given", () => {
    const marks = marksOf({ departure: DEPARTURE }, 48);

    expect(marks.days.length).toBeGreaterThanOrEqual(2);
    expect(marks.days.length).toBeLessThanOrEqual(3);
  });

  it("follows the zone: the same departure crosses midnight at another hour in Tokyo", () => {
    const { days } = marksOf({ ...DENVER, timeZone: "Asia/Tokyo" }, 48);

    // 20:00 UTC is 05:00 the next day in Tokyo, so midnight falls 19 hours later.
    expect(days[0]).toEqual({ hour: 19, weekday: "Thu" });
  });

  it("keeps midnights inside the timeline, in order, one per local day, for any departure and zone", () => {
    const zones = [
      "America/Denver",
      "America/New_York",
      "Europe/London",
      "Asia/Tokyo",
      "Pacific/Auckland",
      "UTC",
    ];
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }),
        fc.constantFrom(...zones),
        fc.integer({ min: 1, max: 96 }),
        (departure, timeZone, totalHours) => {
          const { days } = marksOf({ departure, timeZone, locale: "en-US" }, totalHours);
          const hours = days.map((day) => day.hour);

          expect(hours.every((hour) => hour > -1 / 60 && hour <= totalHours)).toBe(true);
          expect([...hours].sort((a, b) => a - b)).toEqual(hours);
          expect(new Set(hours).size).toBe(hours.length);
          // A span of N hours touches at most floor(N / 24) + 1 midnights.
          expect(hours.length).toBeLessThanOrEqual(Math.floor(totalHours / 24) + 1);
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe("describeTimelineValue", () => {
  it("writes +0 as the departure", () => {
    const reading = readingOf(DENVER, 0);

    expect(reading.valueText).toBe("Tue 2:00 PM, departure");
    expect(reading.weekday).toBe("Tue");
    expect(reading.time).toBe("2:00 PM");
    expect(reading.zone).toBe("MDT");
    expect(reading.offset).toBe("+0 h");
  });

  it("writes a later hour as weekday, time and hours", () => {
    expect(readingOf(DENVER, 6).valueText).toBe("Tue 8:00 PM, +6 hours");
    expect(readingOf(DENVER, 48).valueText).toBe("Thu 2:00 PM, +48 hours");
  });

  it("says one hour in the singular, as a screen reader should speak it (R1-08)", () => {
    expect(readingOf(DENVER, 1).valueText).toBe("Tue 3:00 PM, +1 hour");
    expect(readingOf(DENVER, 2).valueText).toBe("Tue 4:00 PM, +2 hours");
  });

  it("follows the daylight saving change inside the timeline", () => {
    // US clocks go back at 02:00 on 2026-11-01: Sat 22:00 MDT plus 12 hours is Sun 09:00 MST.
    const saturdayNight = Date.UTC(2026, 10, 1, 4, 0, 0);
    const reading = readingOf({ ...DENVER, departure: saturdayNight }, 12);

    expect(reading.zone).toBe("MST");
    expect(reading.time).toBe("9:00 AM");
  });

  it("follows the locale: en-GB is a 24-hour clock", () => {
    const reading = readingOf({ ...DENVER, locale: "en-GB" }, 6);

    expect(reading.time).toBe("20:00");
    expect(reading.valueText).toBe("Tue 20:00, +6 hours");
  });

  it("uses the runtime zone and locale when none are given", () => {
    const reading = readingOf({ departure: DEPARTURE }, 3);

    expect(reading.valueText).toMatch(/, \+3 hours$/);
    expect(reading.zone.length).toBeGreaterThan(0);
  });

  it("accepts a Date as the departure", () => {
    const reading = readingOf({ ...DENVER, departure: new Date(DEPARTURE) }, 6);

    expect(reading.valueText).toBe("Tue 8:00 PM, +6 hours");
  });

  it("always says the hour offset for any position after departure", () => {
    const formatters = createTimelineFormatters(DENVER);
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 48 }), (hour) => {
        expect(
          describeTimelineValue(formatters, hour).valueText.endsWith(`, +${String(hour)} hours`),
        ).toBe(true);
      }),
    );
  });

  describe("the zone of an offset-named zone (R1-09)", () => {
    it.each([
      ["America/Denver", "en-GB", "GMT\u22126"],
      ["America/Sao_Paulo", "en-US", "GMT\u22123"],
      ["Europe/Paris", "en-GB", "CEST"],
      ["America/Denver", "en-US", "MDT"],
    ] as const)(
      "writes %s in %s as %s, with U+2212 and never a hyphen",
      (timeZone, locale, zone) => {
        expect(readingOf({ departure: DEPARTURE, timeZone, locale }, 0).zone).toBe(zone);
      },
    );

    it("never writes a hyphen-minus before a digit in any zone or locale", () => {
      const zones = ["America/Denver", "America/Sao_Paulo", "Pacific/Honolulu", "Asia/Kolkata"];
      fc.assert(
        fc.property(
          fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }),
          fc.constantFrom(...zones),
          fc.constantFrom("en-US", "en-GB"),
          (departure, timeZone, locale) => {
            expect(readingOf({ departure, timeZone, locale }, 0).zone).not.toMatch(/-\d/);
          },
        ),
        { numRuns: 60 },
      );
    });
  });
});

describe("the formatters are built once per clock (R1-06)", () => {
  it("builds no Intl.DateTimeFormat while marking and reading all 49 hours", () => {
    const formatters = createTimelineFormatters(DENVER);
    const construct = vi.spyOn(Intl, "DateTimeFormat");

    timelineMarks(formatters, 48);
    for (let hour = 0; hour <= 48; hour += 1) {
      describeTimelineValue(formatters, hour);
    }

    expect(construct).not.toHaveBeenCalled();
  });

  it("builds its formatters in the clock's own zone and locale", () => {
    const formatters = createTimelineFormatters({ ...DENVER, timeZone: "Asia/Tokyo" });

    expect(describeTimelineValue(formatters, 0).zone).toBe("GMT+9");
  });
});
