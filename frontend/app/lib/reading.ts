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
 * The number of a weather quantity at its digit rule. A negative number takes U+2212, never the
 * hyphen-minus that Intl writes, and a number that rounds to zero takes no sign (see `decimal`).
 */
export function quantityNumber(
  value: number,
  quantity: Quantity,
  locale: string | undefined,
): string {
  const digits = QUANTITY_DIGITS[quantity];
  return decimal(locale, digits, digits)
    .formatToParts(value)
    .map((part) => (part.type === "minusSign" ? MINUS : part.value))
    .join("");
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
