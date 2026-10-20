import { t, tPlural } from "../../foundation/strings";

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
  /** Zone abbreviation, e.g. "MDT", or an offset written with U+2212, e.g. "GMT−6". */
  readonly zone: string;
  /** "+6 h"; "+0 h" is shown as "+0 h" too, the caller decides whether to hide it. */
  readonly offset: string;
  /**
   * `aria-valuetext`: "Tue 2:00 PM, +6 hours", "Tue 3:00 PM, +1 hour", or "Tue 2:00 PM, departure"
   * at +0.
   */
  readonly valueText: string;
}

/**
 * Everything a clock formats with, built once. Constructing an `Intl.DateTimeFormat` costs 25 to 30
 * times what calling one costs, and the slider formats on every value change (R1-06), so a
 * component builds this in `useMemo` next to its marks and passes it to {@link timelineMarks} and
 * {@link describeTimelineValue}; neither of them builds a formatter.
 */
export interface TimelineFormatters {
  /** The departure, in milliseconds since the epoch. */
  readonly departure: number;
  /** Calendar day in the zone, as a sortable string, to notice the day change. */
  readonly day: Intl.DateTimeFormat;
  /** Wall clock time in the zone, on the 24 hour cycle whatever the locale. */
  readonly clock: Intl.DateTimeFormat;
  /** Short weekday name in the zone and the user's locale. */
  readonly weekday: Intl.DateTimeFormat;
  /** Time of day in the user's locale: "2:00 PM", or "14:00" in en-GB. */
  readonly time: Intl.DateTimeFormat;
  /** Zone name in the user's locale, as a short name or a GMT offset. */
  readonly zone: Intl.DateTimeFormat;
}

/** Hours between labelled ticks. */
export const LABEL_EVERY_HOURS = 6;

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;
const MINUS_SIGN = "\u2212";
const HYPHEN_BEFORE_DIGIT = /-(?=\d)/g;

/**
 * Builds the formatters for a clock.
 *
 * @param clock - Departure instant, zone and locale.
 */
export function createTimelineFormatters(clock: TimelineClock): TimelineFormatters {
  const zone = clock.timeZone === undefined ? {} : { timeZone: clock.timeZone };
  return {
    departure: new Date(clock.departure).getTime(),
    day: new Intl.DateTimeFormat("en-CA", {
      ...zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }),
    clock: new Intl.DateTimeFormat("en-US", {
      ...zone,
      hourCycle: "h23",
      hour: "numeric",
      minute: "numeric",
    }),
    weekday: new Intl.DateTimeFormat(clock.locale, { ...zone, weekday: "short" }),
    time: new Intl.DateTimeFormat(clock.locale, { ...zone, hour: "numeric", minute: "2-digit" }),
    zone: new Intl.DateTimeFormat(clock.locale, { ...zone, timeZoneName: "short" }),
  };
}

function instantAt(formatters: TimelineFormatters, hour: number): Date {
  return new Date(formatters.departure + hour * MS_PER_HOUR);
}

/** The formatted parts of an instant, by type: `{ hour: "14", minute: "05", ... }`. */
function partsOf(format: Intl.DateTimeFormat, instant: Date): Readonly<Record<string, string>> {
  return Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, part.value]));
}

/** Minutes after local midnight, read from the parts of the `clock` formatter. */
function minutesSinceMidnight(parts: Readonly<Record<string, string>>): number {
  return Number(parts["hour"]) * 60 + Number(parts["minute"]);
}

/**
 * Tick marks for a timeline of `totalHours`: whole hours, labelled sixth hours, and the local
 * midnights in between (found by watching the calendar day change from one hour to the next).
 *
 * @param formatters - From {@link createTimelineFormatters}, built once for the clock.
 * @param totalHours - Length of the timeline, 48 for the forecast.
 */
export function timelineMarks(formatters: TimelineFormatters, totalHours: number): TimelineMarks {
  const hours = Array.from({ length: totalHours + 1 }, (_unused, hour) => hour);
  const labels = hours
    .filter((hour) => hour > 0 && hour % LABEL_EVERY_HOURS === 0)
    .map((hour) => ({ hour, text: t("timeline.offset", { hours: hour }) }));
  const days: TimelineDay[] = [];
  let previousDay = formatters.day.format(instantAt(formatters, 0));
  for (let hour = 1; hour <= totalHours; hour += 1) {
    const here = instantAt(formatters, hour);
    const day = formatters.day.format(here);
    if (day !== previousDay) {
      // The instant `hour` is `minutes` after midnight, so midnight fell that long before it.
      const midnight = hour - minutesSinceMidnight(partsOf(formatters.clock, here)) / 60;
      const start = new Date(instantAt(formatters, midnight).getTime() + MS_PER_MINUTE);
      days.push({ hour: midnight, weekday: formatters.weekday.format(start) });
    }
    previousDay = day;
  }
  return { hours, labels, days };
}

/**
 * Describes one slider position.
 *
 * @param formatters - From {@link createTimelineFormatters}, built once for the clock.
 * @param hour - Hours after departure.
 */
export function describeTimelineValue(
  formatters: TimelineFormatters,
  hour: number,
): TimelineReading {
  const instant = instantAt(formatters, hour);
  const weekday = formatters.weekday.format(instant);
  const time = formatters.time.format(instant);
  // DESIGN.md section 5 writes UTC offsets with U+2212, never a hyphen-minus; Intl writes "GMT-6".
  const zone = String(partsOf(formatters.zone, instant)["timeZoneName"]).replace(
    HYPHEN_BEFORE_DIGIT,
    MINUS_SIGN,
  );
  return {
    weekday,
    time,
    zone,
    offset: t("timeline.offset", { hours: hour }),
    valueText:
      hour === 0
        ? t("timeline.valueTextZero", { weekday, time })
        : tPlural("timeline.valueText", hour, { weekday, time }),
  };
}
