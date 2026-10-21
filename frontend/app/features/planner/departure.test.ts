import { CalendarDate, CalendarDateTime, Time, ZonedDateTime } from "@internationalized/date";
import { describe, expect, it } from "vitest";

import {
  chipDeparture,
  dateFromField,
  departureDays,
  departureOf,
  initialDeparture,
  instantOf,
  timeFromField,
  zoneNote,
} from "./departure";

const DENVER = "America/Denver";

describe("departureOf", () => {
  it("is the wall-clock date and minute of an instant in the zone", () => {
    const value = departureOf(new Date("2026-10-20T14:00:42Z"), DENVER);

    expect(value.date.toString()).toBe("2026-10-20");
    expect(value.time.toString()).toBe("08:00:00");
  });

  it("is the previous day for an instant before local midnight", () => {
    expect(departureOf(new Date("2026-10-21T05:30:00Z"), DENVER).date.toString()).toBe(
      "2026-10-20",
    );
  });
});

describe("instantOf", () => {
  it("is empty while the date or the time is", () => {
    const date = new CalendarDate(2026, 10, 20);
    const time = new Time(8, 0);

    expect(instantOf({ date: null, time: null }, DENVER)).toBeNull();
    expect(instantOf({ date, time: null }, DENVER)).toBeNull();
    expect(instantOf({ date: null, time }, DENVER)).toBeNull();
  });

  it("is the instant the date and time name in the zone", () => {
    const value = { date: new CalendarDate(2026, 10, 20), time: new Time(8, 0) };

    expect(instantOf(value, DENVER)?.toISOString()).toBe("2026-10-20T14:00:00.000Z");
  });

  it("round-trips with departureOf", () => {
    const instant = new Date("2026-10-20T14:35:00Z");

    expect(instantOf(departureOf(instant, DENVER), DENVER)).toEqual(instant);
  });

  it("moves a time that clocks skip (spring forward) to the moment after the gap", () => {
    const skipped = { date: new CalendarDate(2027, 3, 14), time: new Time(2, 30) };

    expect(instantOf(skipped, DENVER)?.toISOString()).toBe("2027-03-14T09:30:00.000Z");
  });

  it("takes the first of a time that happens twice (fall back)", () => {
    const twice = { date: new CalendarDate(2026, 11, 1), time: new Time(1, 30) };

    expect(instantOf(twice, DENVER)?.toISOString()).toBe("2026-11-01T07:30:00.000Z");
  });
});

describe("chipDeparture", () => {
  const now = new Date("2026-10-21T05:30:00Z");

  it("Now is the current minute on the wall clock", () => {
    const value = chipDeparture("now", now, DENVER);

    expect([value.date.toString(), value.time.toString()]).toEqual(["2026-10-20", "23:30:00"]);
  });

  it("+3 h crosses midnight into the next day", () => {
    const value = chipDeparture("plus3h", now, DENVER);

    expect([value.date.toString(), value.time.toString()]).toEqual(["2026-10-21", "02:30:00"]);
  });

  it("Tomorrow 06:00 is the next calendar day at six, whatever the time now", () => {
    const value = chipDeparture("tomorrow0600", now, DENVER);

    expect([value.date.toString(), value.time.toString()]).toEqual(["2026-10-21", "06:00:00"]);
  });
});

describe("departureDays", () => {
  it("are the days of the API's window on the wall clock", () => {
    const { first, last } = departureDays(new Date("2026-10-20T12:00:00Z"), DENVER);

    expect(first.toString()).toBe("2026-10-20");
    expect(last.toString()).toBe("2026-10-25");
  });
});

describe("zoneNote", () => {
  it("names the zone and its UTC offset", () => {
    expect(zoneNote(new Date("2026-10-20T12:00:00Z"), "en-US", DENVER)).toEqual({
      zone: "Mountain Daylight Time",
      offset: "UTC\u22126",
    });
  });

  it("follows daylight saving time", () => {
    expect(zoneNote(new Date("2026-12-20T12:00:00Z"), "en-US", DENVER)).toEqual({
      zone: "Mountain Standard Time",
      offset: "UTC\u22127",
    });
  });

  it("writes a half-hour offset in full", () => {
    expect(zoneNote(new Date("2026-10-20T12:00:00Z"), "en-US", "Asia/Kolkata").offset).toBe(
      "UTC+5:30",
    );
  });
});

describe("initialDeparture", () => {
  const clock = { now: () => new Date("2026-10-20T14:00:42Z"), timeZone: DENVER };

  it("is empty while there is no clock (the prerendered page)", () => {
    expect(initialDeparture(undefined, null)).toEqual({ date: null, time: null });
    expect(initialDeparture(new Date("2026-10-21T14:00:00Z"), null)).toEqual({
      date: null,
      time: null,
    });
  });

  it("is the current minute when a link carried no departure", () => {
    const value = initialDeparture(undefined, clock);

    expect([value.date?.toString(), value.time?.toString()]).toEqual(["2026-10-20", "08:00:00"]);
  });

  it("is the departure a link carried, on the visitor's wall clock", () => {
    const value = initialDeparture(new Date("2026-10-22T20:15:00Z"), clock);

    expect([value.date?.toString(), value.time?.toString()]).toEqual(["2026-10-22", "14:15:00"]);
  });
});

describe("dateFromField", () => {
  it("is empty when the date field is", () => {
    expect(dateFromField(null)).toBeNull();
  });

  it("keeps only the calendar date of a date, a date with a time and a zoned date", () => {
    const day = new CalendarDate(2026, 10, 22);

    expect(dateFromField(day)?.toString()).toBe("2026-10-22");
    expect(dateFromField(new CalendarDateTime(2026, 10, 22, 14, 15))?.toString()).toBe(
      "2026-10-22",
    );
    expect(
      dateFromField(new ZonedDateTime(2026, 10, 22, DENVER, -6 * 3_600_000, 23, 30))?.toString(),
    ).toBe("2026-10-22");
  });
});

describe("timeFromField", () => {
  it("is empty when the time field is", () => {
    expect(timeFromField(null)).toBeNull();
  });

  it("keeps the hour and the minute and drops the seconds", () => {
    expect(timeFromField(new Time(14, 15, 59))?.toString()).toBe("14:15:00");
  });
});
