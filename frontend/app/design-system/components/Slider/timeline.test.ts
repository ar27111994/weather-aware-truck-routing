import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { describeTimelineValue, timelineMarks } from "./timeline";

// Tue 2026-10-20 14:00 in Denver (MDT, UTC-6) is 20:00 UTC.
const DEPARTURE = Date.UTC(2026, 9, 20, 20, 0, 0);
const DENVER = { departure: DEPARTURE, timeZone: "America/Denver", locale: "en-US" } as const;

describe("timelineMarks", () => {
  it("has a mark for every whole hour from 0 to the end", () => {
    const { hours } = timelineMarks(DENVER, 48);

    expect(hours).toHaveLength(49);
    expect(hours[0]).toBe(0);
    expect(hours.at(-1)).toBe(48);
  });

  it("labels every sixth hour after 0 and never +0", () => {
    const { labels } = timelineMarks(DENVER, 48);

    expect(labels.map((label) => label.hour)).toEqual([6, 12, 18, 24, 30, 36, 42, 48]);
    expect(labels.map((label) => label.text).slice(0, 2)).toEqual(["+6 h", "+12 h"]);
  });

  it("finds local midnights and names the day that starts there", () => {
    const { days } = timelineMarks(DENVER, 48);

    expect(days).toEqual([
      { hour: 10, weekday: "Wed" },
      { hour: 34, weekday: "Thu" },
    ]);
  });

  it("finds a fractional midnight when the departure is not on the hour", () => {
    const { days } = timelineMarks({ ...DENVER, departure: DEPARTURE + 20 * 60_000 }, 48);

    expect(days[0]?.hour).toBeCloseTo(10 - 20 / 60, 6);
  });

  it("puts a midnight exactly on the hour at that hour", () => {
    const midnight = Date.UTC(2026, 9, 21, 6, 0, 0);
    const { days } = timelineMarks({ ...DENVER, departure: midnight - 5 * 3_600_000 }, 12);

    expect(days).toEqual([{ hour: 5, weekday: "Wed" }]);
  });

  it("finds no midnight in a short timeline that stays within one day", () => {
    expect(timelineMarks(DENVER, 6).days).toEqual([]);
  });

  it("uses the runtime zone and locale when none are given", () => {
    const marks = timelineMarks({ departure: DEPARTURE }, 48);

    expect(marks.days.length).toBeGreaterThanOrEqual(2);
    expect(marks.days.length).toBeLessThanOrEqual(3);
  });

  it("follows the zone: the same departure crosses midnight at another hour in Tokyo", () => {
    const { days } = timelineMarks({ ...DENVER, timeZone: "Asia/Tokyo" }, 48);

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
          const { days } = timelineMarks({ departure, timeZone, locale: "en-US" }, totalHours);
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
    const reading = describeTimelineValue(DENVER, 0);

    expect(reading.valueText).toBe("Tue 2:00 PM, departure");
    expect(reading.weekday).toBe("Tue");
    expect(reading.time).toBe("2:00 PM");
    expect(reading.zone).toBe("MDT");
    expect(reading.offset).toBe("+0 h");
  });

  it("writes a later hour as weekday, time and hours", () => {
    expect(describeTimelineValue(DENVER, 6).valueText).toBe("Tue 8:00 PM, +6 hours");
    expect(describeTimelineValue(DENVER, 48).valueText).toBe("Thu 2:00 PM, +48 hours");
  });

  it("follows the daylight saving change inside the timeline", () => {
    // US clocks go back at 02:00 on 2026-11-01: Sat 22:00 MDT plus 12 hours is Sun 09:00 MST.
    const saturdayNight = Date.UTC(2026, 10, 1, 4, 0, 0);
    const reading = describeTimelineValue({ ...DENVER, departure: saturdayNight }, 12);

    expect(reading.zone).toBe("MST");
    expect(reading.time).toBe("9:00 AM");
  });

  it("follows the locale: en-GB is a 24-hour clock", () => {
    const reading = describeTimelineValue({ ...DENVER, locale: "en-GB" }, 6);

    expect(reading.time).toBe("20:00");
    expect(reading.valueText).toBe("Tue 20:00, +6 hours");
  });

  it("uses the runtime zone and locale when none are given", () => {
    const reading = describeTimelineValue({ departure: DEPARTURE }, 3);

    expect(reading.valueText).toMatch(/, \+3 hours$/);
    expect(reading.zone.length).toBeGreaterThan(0);
  });

  it("accepts a Date as the departure", () => {
    const reading = describeTimelineValue({ ...DENVER, departure: new Date(DEPARTURE) }, 6);

    expect(reading.valueText).toBe("Tue 8:00 PM, +6 hours");
  });

  it("always says the hour offset for any position after departure", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 48 }), (hour) => {
        expect(
          describeTimelineValue(DENVER, hour).valueText.endsWith(`, +${String(hour)} hours`),
        ).toBe(true);
      }),
    );
  });
});
