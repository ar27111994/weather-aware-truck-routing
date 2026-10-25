import { decimal, MINUS } from "./decimal";
import type { LocaleOptions } from "./decimal";

/**
 * The decimals of each quantity a checkpoint's weather is shown in (DESIGN.md section 2): speeds to
 * a tenth (the API's own precision), rain and snow rates to a thousandth (the domain classifies at
 * 0.001, so two decimals could show 0.25 next to "Moderate") and temperature to a tenth, which keeps
 * the freezing line visible (31.6 and 32.4 are not both 32). One rule per quantity: the popover
 * (number and unit) and the table cell (number only) both read it, so they cannot disagree. It sits
 * in a module of its own, small on purpose: the /design style guide reads it too, and a page loads
 * every module it imports.
 */
const QUANTITY_DIGITS = { speed: 1, rate: 3, temperature: 1 } as const;

type Quantity = keyof typeof QUANTITY_DIGITS;

/** Which quantity each reading of a checkpoint's weather is: wind and gust are speeds, rain and snow rates. */
const READING_QUANTITY = {
  wind: "speed",
  gust: "speed",
  rain: "rate",
  snow: "rate",
  temp: "temperature",
} as const satisfies Record<string, Quantity>;

/** One of the readings of a checkpoint's weather. */
export type WeatherReading = keyof typeof READING_QUANTITY;

/**
 * The digits of a formatted number: its integer and fraction parts, in the digits of the locale's
 * numbering system, which are not always 0 to 9.
 */
function digitsOf(parts: readonly Intl.NumberFormatPart[]): string {
  return parts
    .map((part) => (part.type === "integer" || part.type === "fraction" ? part.value : ""))
    .join("");
}

/**
 * The number of a weather quantity at its digit rule. A negative number takes U+2212, never the
 * hyphen-minus that Intl writes. A number that rounds to zero is written as zero is, with no sign
 * and none of the direction marks that some locales put before one: `-0.04` at one decimal is
 * `0.0`, never `\u22120.0`. That is decided from the digits Intl wrote, by comparing them with the
 * digits of zero, and never from a rounding of our own, so the sign and the digits cannot
 * disagree.
 */
export function quantityNumber(
  value: number,
  quantity: Quantity,
  locale: string | undefined,
): string {
  const digits = QUANTITY_DIGITS[quantity];
  const format = decimal(locale, digits, digits);
  const parts = format.formatToParts(value);
  const zero = format.formatToParts(0);
  const written = digitsOf(parts) === digitsOf(zero) ? zero : parts;
  return written.map((part) => (part.type === "minusSign" ? MINUS : part.value)).join("");
}

/**
 * A weather reading's number without its unit, for a table cell (the column header carries the
 * unit): `27.4`, `0.012`, `\u22123.5`.
 *
 * @throws {RangeError} unless `value` is finite.
 */
export function formatReading(
  value: number,
  reading: WeatherReading,
  options: LocaleOptions = {},
): string {
  if (!Number.isFinite(value))
    throw new RangeError(`formatReading expects a finite number, got ${String(value)}`);
  return quantityNumber(value, READING_QUANTITY[reading], options.locale);
}
