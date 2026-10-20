/**
 * Display formatting for a US-first trucking app, built on `Intl` (no date library). Quantity
 * formatters reject negative, NaN and infinite input with a `RangeError`: a wrong number must never
 * be shown quietly. Time follows the user's locale (D-16); the default is en-US (12-hour clock).
 */
const DEFAULT_LOCALE = "en-US";
const MAX_UTC_OFFSET_S = 18 * 3600;
const MINUS = "\u2212";

/** Locale override shared by the formatters that depend on number conventions. */
export interface LocaleOptions {
  /** BCP 47 tag; defaults to `en-US`. */
  readonly locale?: string;
}

function requireQuantity(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} expects a finite, non-negative number, got ${String(value)}`);
  }
  return Math.abs(value);
}

const numberFormats = new Map<string, Intl.NumberFormat>();

/** A cached `Intl.NumberFormat` (constructing one per call is slow enough to matter in bulk). */
function decimal(locale: string | undefined, minimum: number, maximum: number): Intl.NumberFormat {
  const resolved = locale ?? DEFAULT_LOCALE;
  const key = `${resolved}|${String(minimum)}|${String(maximum)}`;
  const cached = numberFormats.get(key);
  if (cached) return cached;
  const created = new Intl.NumberFormat(resolved, {
    minimumFractionDigits: minimum,
    maximumFractionDigits: maximum,
  });
  numberFormats.set(key, created);
  return created;
}

/** Miles to one decimal with grouping: `537.1 mi`, `1,016.4 mi`. */
export function formatMiles(
  miles: number,
  options: LocaleOptions & { readonly unit?: boolean } = {},
): string {
  const text = decimal(options.locale, 1, 1).format(requireQuantity("formatMiles", miles));
  return options.unit === false ? text : `${text} mi`;
}

/** Whole minutes as `38 min`, `8 h` or `7 h 44 min`; long trips stay in hours (`100 h`). */
export function formatDuration(seconds: number): string {
  const totalMinutes = Math.round(requireQuantity("formatDuration", seconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${String(minutes)} min`;
  const hoursText = `${decimal(DEFAULT_LOCALE, 0, 0).format(hours)} h`;
  return minutes === 0 ? hoursText : `${hoursText} ${String(minutes)} min`;
}

/** A signed time difference: `+23 min`, `\u22121 h 5 min`; no sign when it rounds to zero minutes. */
export function formatDurationDelta(seconds: number): string {
  if (!Number.isFinite(seconds))
    throw new RangeError(`formatDurationDelta expects a finite number, got ${String(seconds)}`);
  const text = formatDuration(Math.abs(seconds));
  if (Math.round(Math.abs(seconds) / 60) === 0) return text;
  return `${seconds > 0 ? "+" : MINUS}${text}`;
}

/** Pounds as an integer with separators: `38,000 lb`. */
export function formatPounds(pounds: number, options: LocaleOptions = {}): string {
  return `${decimal(options.locale, 0, 0).format(requireQuantity("formatPounds", pounds))} lb`;
}

/** Wind speed to one decimal: `12.3 mph`. */
export function formatMph(mph: number, options: LocaleOptions = {}): string {
  return `${decimal(options.locale, 1, 1).format(requireQuantity("formatMph", mph))} mph`;
}

/** Precipitation rate with two to three decimals: `0.10 in/hr`, `0.125 in/hr`. */
export function formatInchesPerHour(rate: number, options: LocaleOptions = {}): string {
  return `${decimal(options.locale, 2, 3).format(requireQuantity("formatInchesPerHour", rate))} in/hr`;
}

/** Temperature rounded to a whole degree: `48\u00b0F`; negatives allowed, never `-0`. */
export function formatFahrenheit(degrees: number, options: LocaleOptions = {}): string {
  if (!Number.isFinite(degrees))
    throw new RangeError(`formatFahrenheit expects a finite number, got ${String(degrees)}`);
  return `${decimal(options.locale, 0, 0).format(Math.round(degrees) + 0)}\u00b0F`;
}

/** Whole hours with an explicit sign for the forecast slider: `+6 h`, `+0 h`, `\u22123 h`. */
export function formatHoursFromDeparture(hours: number): string {
  if (!Number.isInteger(hours))
    throw new RangeError(`formatHoursFromDeparture expects an integer, got ${String(hours)}`);
  return `${hours < 0 ? MINUS : "+"}${String(Math.abs(hours))} h`;
}

/**
 * A UTC offset label: `UTC−6`, `UTC+5:30`, `UTC+0`.
 *
 * @throws {RangeError} unless `offsetSeconds` is a whole number of minutes within ±18 h.
 */
export function formatUtcOffset(offsetSeconds: number): string {
  if (
    !Number.isInteger(offsetSeconds) ||
    offsetSeconds % 60 !== 0 ||
    Math.abs(offsetSeconds) > MAX_UTC_OFFSET_S
  ) {
    throw new RangeError(
      `formatUtcOffset expects whole minutes within ±18 h, got ${String(offsetSeconds)}`,
    );
  }
  const absolute = Math.abs(offsetSeconds);
  const minutes = (absolute % 3600) / 60;
  const minutesText = minutes === 0 ? "" : `:${String(minutes).padStart(2, "0")}`;
  return `UTC${offsetSeconds < 0 ? MINUS : "+"}${String(Math.floor(absolute / 3600))}${minutesText}`;
}

/** The time zone of a checkpoint, as the API reports it. */
export interface ZoneInfo {
  /** IANA name (`America/Denver`), used for the abbreviation only. */
  readonly timezone: string;
  /** Offset from UTC at that instant, in seconds; the clock time is computed from it. */
  readonly utc_offset_s: number;
}

function zoneLabel(zone: ZoneInfo, instant: number, locale: string): string {
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone: zone.timezone,
      timeZoneName: "short",
    }).formatToParts(instant);
    const name = parts
      .filter((part) => part.type === "timeZoneName")
      .map((part) => part.value)
      .join("");
    return name === "" || name.startsWith("GMT") ? formatUtcOffset(zone.utc_offset_s) : name;
  } catch {
    return formatUtcOffset(zone.utc_offset_s);
  }
}

/**
 * The wall-clock time of a UTC instant in `zone`: `Tue 8:00 AM MDT`. The clock comes from the
 * numeric offset (DST-free, independent of the host time zone database); the abbreviation from the
 * IANA name, falling back to a UTC offset label when Intl cannot name the zone.
 *
 * @throws {RangeError} for an unparsable timestamp.
 */
export function formatLocalTime(
  isoUtc: string,
  zone: ZoneInfo,
  options: LocaleOptions & { readonly weekday?: boolean } = {},
): string {
  const instant = Date.parse(isoUtc);
  if (Number.isNaN(instant)) throw new RangeError(`formatLocalTime cannot parse "${isoUtc}"`);
  const locale = options.locale ?? DEFAULT_LOCALE;
  const clock = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
    ...(options.weekday === false ? {} : { weekday: "short" }),
  }).format(instant + zone.utc_offset_s * 1000);
  return `${clock} ${zoneLabel(zone, instant, locale)}`;
}
