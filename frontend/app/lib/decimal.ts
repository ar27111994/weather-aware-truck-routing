/**
 * The number formatter that lib/format.ts and lib/reading.ts share. It is a module of its own so
 * that a page that only needs a weather reading (the /design style guide) does not load every
 * formatter with it.
 */
export const DEFAULT_LOCALE = "en-US";

/** U+2212, the minus of a negative number or offset (DESIGN.md section 2), never a hyphen-minus. */
export const MINUS = "\u2212";

/** Locale override shared by the formatters that depend on number conventions. */
export interface LocaleOptions {
  /** BCP 47 tag; defaults to `en-US`. */
  readonly locale?: string;
}

const numberFormats = new Map<string, Intl.NumberFormat>();

/**
 * A cached `Intl.NumberFormat` (constructing one per call is slow enough to matter in bulk). It
 * sets no option that `Intl.NumberFormat` gained in its version 3 (Chrome 106, Safari 15.4 and
 * Firefox 116): an engine that does not know the value of an option throws a `RangeError` when it
 * builds the formatter, and every number the page writes goes through here (engine-floor.test.ts
 * runs the formatters on such an engine). A number that rounds to zero is written without a sign
 * by `quantityNumber` (lib/reading.ts), not by an option of the formatter.
 */
export function decimal(
  locale: string | undefined,
  minimum: number,
  maximum: number,
): Intl.NumberFormat {
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
