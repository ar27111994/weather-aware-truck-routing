import {
  Time,
  fromDate,
  toCalendarDate,
  toZoned,
  type CalendarDate,
  type DateValue,
} from "@internationalized/date";

import { formatUtcOffset } from "../../lib/format";
import { departureBounds } from "./trip-schema";

/** A departure a chip or the clock gives: a calendar date and a clock time on the visitor's wall clock. */
export interface DepartureValue {
  readonly date: CalendarDate;
  readonly time: Time;
}

/** The departure fields as the form edits them: either part can be empty. */
export interface DepartureDraft {
  readonly date: CalendarDate | null;
  readonly time: Time | null;
}

/** The quick choices under the departure field (R1). */
export type DepartureChip = "now" | "plus3h" | "tomorrow0600";

const HOUR_MS = 3_600_000;

/** The wall-clock date and minute an instant has in `timeZone`. */
export function departureOf(instant: Date, timeZone: string): DepartureValue {
  const zoned = fromDate(instant, timeZone);
  return { date: toCalendarDate(zoned), time: new Time(zoned.hour, zoned.minute) };
}

/**
 * The instant the date and time name in `timeZone`, or `null` while either is empty. A time that does
 * not exist (the hour skipped when clocks go forward) resolves to the moment after it, and one that
 * happens twice (clocks going back) to the first, as `Date` does.
 */
export function instantOf(draft: DepartureDraft, timeZone: string): Date | null {
  const { date, time } = draft;
  if (date === null || time === null) return null;
  return toZoned(date, timeZone)
    .set({ hour: time.hour, minute: time.minute, second: 0, millisecond: 0 }, "compatible")
    .toDate();
}

/** What a quick chip sets, measured from `now` on the wall clock of `timeZone`. */
export function chipDeparture(chip: DepartureChip, now: Date, timeZone: string): DepartureValue {
  switch (chip) {
    case "now":
      return departureOf(now, timeZone);
    case "plus3h":
      return departureOf(new Date(now.getTime() + 3 * HOUR_MS), timeZone);
    case "tomorrow0600":
      return {
        date: toCalendarDate(fromDate(now, timeZone)).add({ days: 1 }),
        time: new Time(6, 0),
      };
  }
}

/** The first and last calendar days a departure may fall on (the API's window, on the wall clock). */
export function departureDays(
  now: Date,
  timeZone: string,
): { readonly first: CalendarDate; readonly last: CalendarDate } {
  const { earliest, latest } = departureBounds(now);
  return {
    first: toCalendarDate(fromDate(earliest, timeZone)),
    last: toCalendarDate(fromDate(latest, timeZone)),
  };
}

/** The zone's long name and its UTC offset at `now`: what the caption under the field says. */
export function zoneNote(
  now: Date,
  locale: string,
  timeZone: string,
): { readonly zone: string; readonly offset: string } {
  const zone = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "long" })
    .formatToParts(now)
    .filter((part) => part.type === "timeZoneName")
    .map((part) => part.value)
    .join("");
  return { zone, offset: formatUtcOffset(fromDate(now, timeZone).offset / 1000) };
}

/** The visitor's clock and time zone. Only the browser has them, so the prerendered page has none. */
export interface Clock {
  readonly now: () => Date;
  /** IANA name, such as `America/Denver`: the wall clock the date and time are read on. */
  readonly timeZone: string;
}

/** The empty departure fields. */
export const NO_DEPARTURE: DepartureDraft = { date: null, time: null };

/**
 * What the departure fields start with: the departure a link carried, else the current minute
 * (the "Now" chip), else nothing while there is no clock (the prerendered page).
 */
export function initialDeparture(depart: Date | undefined, clock: Clock | null): DepartureDraft {
  if (clock === null) return NO_DEPARTURE;
  return departureOf(depart ?? clock.now(), clock.timeZone);
}

/**
 * The date a date field reports, as the plain calendar date the form keeps. A date field hands over
 * a richer value (it may carry a time of day or a zone) or `null` once the date is emptied.
 */
export function dateFromField(value: DateValue | null): CalendarDate | null {
  return value === null ? null : toCalendarDate(value);
}

/** The time a time field reports, as the hour and minute the form keeps (or `null` once emptied). */
export function timeFromField(
  value: { readonly hour: number; readonly minute: number } | null,
): Time | null {
  return value === null ? null : new Time(value.hour, value.minute);
}
