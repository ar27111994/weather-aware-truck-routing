import { t } from "../../foundation/strings";

/** What the timeline needs to turn "hours after departure" into wall-clock text. */
export interface TimelineClock {
  /** The instant of +0 h: the departure. */
  readonly departure: Date | number;
  /** IANA zone the labels are written in, such as "America/Denver". Defaults to the user's zone. */
  readonly timeZone?: string;
  /** BCP 47 locale for weekday and time text (D-16: en-US means a 12-hour clock). */
  readonly locale?: string;
}

/** A tick that carries a printed label ("+6 h"). */
export interface TimelineLabel {
  readonly hour: number;
  readonly text: string;
}

/** Local midnight inside the timeline: where a new day starts and what it is called ("Wed"). */
export interface TimelineDay {
  /** Hours after departure; fractional when the departure is not on the hour. */
  readonly hour: number;
  readonly weekday: string;
}

export interface TimelineMarks {
  /** Every whole hour from 0 to the end, for the 1 px by 6 px tick marks. */
  readonly hours: readonly number[];
  /** Every sixth hour after 0, for the 10 px ticks with a `+6 h` label. */
  readonly labels: readonly TimelineLabel[];
  readonly days: readonly TimelineDay[];
}

/** How a slider position reads aloud and on screen. */
export interface TimelineReading {
  readonly weekday: string;
  /** Local time of day, e.g. "2:00 PM". */
  readonly time: string;
  /** Zone abbreviation, e.g. "MDT". */
  readonly zone: string;
  /** "+6 h"; "+0 h" is shown as "+0 h" too, the caller decides whether to hide it. */
  readonly offset: string;
  /** `aria-valuetext`: "Tue 2:00 PM, +6 hours", or "Tue 2:00 PM, departure" at +0. */
  readonly valueText: string;
}

/** Hours between labelled ticks. */
export const LABEL_EVERY_HOURS = 6;

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

function instantAt(clock: TimelineClock, hour: number): Date {
  return new Date(new Date(clock.departure).getTime() + hour * MS_PER_HOUR);
}

function zoneOptions(clock: TimelineClock): Intl.DateTimeFormatOptions {
  return clock.timeZone === undefined ? {} : { timeZone: clock.timeZone };
}

// The formatters below are built once per call and reused: constructing an `Intl.DateTimeFormat`
// costs far more than calling one, and a 48 hour timeline would otherwise build two per hour.
/** Calendar day in the zone, as a sortable string, to notice the day change. */
function localDay(clock: TimelineClock): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    ...zoneOptions(clock),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** Wall clock time in the zone, on the 24 hour cycle whatever the locale. */
function localClock(clock: TimelineClock): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    ...zoneOptions(clock),
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
  });
}

/** Short weekday name in the zone and the user's locale. */
function localWeekday(clock: TimelineClock): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(clock.locale, { ...zoneOptions(clock), weekday: "short" });
}

/** The formatted parts of an instant, by type: `{ hour: "14", minute: "05", ... }`. */
function partsOf(format: Intl.DateTimeFormat, instant: Date): Readonly<Record<string, string>> {
  return Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, part.value]));
}

/** Minutes after local midnight, read from the parts of a `localClock` formatter. */
function minutesSinceMidnight(parts: Readonly<Record<string, string>>): number {
  return Number(parts["hour"]) * 60 + Number(parts["minute"]);
}

/**
 * Tick marks for a timeline of `totalHours`: whole hours, labelled sixth hours, and the local
 * midnights in between (found by watching the calendar day change from one hour to the next).
 *
 * @param clock - Departure instant, zone and locale.
 * @param totalHours - Length of the timeline, 48 for the forecast.
 */
export function timelineMarks(clock: TimelineClock, totalHours: number): TimelineMarks {
  const hours = Array.from({ length: totalHours + 1 }, (_unused, hour) => hour);
  const labels = hours
    .filter((hour) => hour > 0 && hour % LABEL_EVERY_HOURS === 0)
    .map((hour) => ({ hour, text: t("timeline.offset", { hours: hour }) }));
  const dayOf = localDay(clock);
  const clockOf = localClock(clock);
  const weekdayOf = localWeekday(clock);
  const days: TimelineDay[] = [];
  let previousDay = dayOf.format(instantAt(clock, 0));
  for (let hour = 1; hour <= totalHours; hour += 1) {
    const here = instantAt(clock, hour);
    const day = dayOf.format(here);
    if (day !== previousDay) {
      // The instant `hour` is `minutes` after midnight, so midnight fell that long before it.
      const midnight = hour - minutesSinceMidnight(partsOf(clockOf, here)) / 60;
      const start = new Date(instantAt(clock, midnight).getTime() + MS_PER_MINUTE);
      days.push({ hour: midnight, weekday: weekdayOf.format(start) });
    }
    previousDay = day;
  }
  return { hours, labels, days };
}

/**
 * Describes one slider position.
 *
 * @param clock - Departure instant, zone and locale.
 * @param hour - Hours after departure.
 */
export function describeTimelineValue(clock: TimelineClock, hour: number): TimelineReading {
  const instant = instantAt(clock, hour);
  const weekday = localWeekday(clock).format(instant);
  const timeFormat = new Intl.DateTimeFormat(clock.locale, {
    ...zoneOptions(clock),
    hour: "numeric",
    minute: "2-digit",
  });
  const time = timeFormat.format(instant);
  const zone = String(
    partsOf(
      new Intl.DateTimeFormat(clock.locale, { ...zoneOptions(clock), timeZoneName: "short" }),
      instant,
    )["timeZoneName"],
  );
  return {
    weekday,
    time,
    zone,
    offset: t("timeline.offset", { hours: hour }),
    valueText:
      hour === 0
        ? t("timeline.valueTextZero", { weekday, time })
        : t("timeline.valueText", { weekday, time, hours: hour }),
  };
}
