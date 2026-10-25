import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The planner has to run on every engine that has `Intl.NumberFormat`, not only on the ones that
 * have its version 3 (Chrome 106, Safari 15.4, Firefox 116). An older engine does not ignore an
 * option value it does not know: ECMA-402's GetOption throws a RangeError for a value outside its
 * list, and a formatter is built when the page writes its first number. `decimal()` once passed
 * the v3 value "negative" for the sign option, so on Chrome 105 or Firefox 115 the results view
 * threw at its first number (TMP-F1).
 *
 * `onOldEngine` is such an engine: the real constructor, except that it refuses that value. The
 * modules are loaded after the stand-in is installed, because `decimal.ts` keeps its formatters at
 * module level.
 */

const MINUS = "\u2212";
const RealNumberFormat = Intl.NumberFormat;

/** `new Intl.NumberFormat` as an engine before version 3 runs it. */
function NumberFormatBeforeV3(
  locales?: string | readonly string[],
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  if (options?.signDisplay === "negative") {
    throw new RangeError(
      "Value negative out of range for Intl.NumberFormat options property signDisplay",
    );
  }
  return new RealNumberFormat(locales, options);
}

/** Installs the stand-in, then loads the formatters fresh, so they build theirs on it. */
async function onOldEngine() {
  vi.resetModules();
  vi.stubGlobal("Intl", Object.create(Intl, { NumberFormat: { value: NumberFormatBeforeV3 } }));
  return { ...(await import("./format")), ...(await import("./reading")) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the stand-in for an engine before Intl.NumberFormat v3", () => {
  it("refuses the v3 value and builds every other formatter as the real engine does", () => {
    vi.stubGlobal("Intl", Object.create(Intl, { NumberFormat: { value: NumberFormatBeforeV3 } }));

    expect(() => new Intl.NumberFormat("en-US", { signDisplay: "negative" })).toThrow(RangeError);
    expect(new Intl.NumberFormat("en-US", { signDisplay: "never" }).format(-1)).toBe("1");
    expect(new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(1234.56)).toBe(
      "1,234.6",
    );
  });
});

describe("the formatters on an engine that rejects the sign option's v3 value", () => {
  it.each([
    [48.2, "48.2"],
    [-0.04, "0.0"],
    [-0.06, `${MINUS}0.1`],
    [-0.4, `${MINUS}0.4`],
    [-3.6, `${MINUS}3.6`],
    [-10.4, `${MINUS}10.4`],
  ] as const)("writes the temperature %f as %s", async (value, text) => {
    const { formatReading } = await onOldEngine();

    expect(formatReading(value, "temp")).toBe(text);
  });

  it.each([
    [0, "0.000"],
    [0.0004, "0.000"],
    [0.012, "0.012"],
    [0.62, "0.620"],
    [0.2496, "0.250"],
  ] as const)("writes the rain rate %f as %s", async (value, text) => {
    const { formatReading } = await onOldEngine();

    expect(formatReading(value, "rain")).toBe(text);
  });

  it.each([
    [27.44, "27.4"],
    [0.04, "0.0"],
  ] as const)("writes the wind speed %f as %s", async (value, text) => {
    const { formatReading } = await onOldEngine();

    expect(formatReading(value, "wind")).toBe(text);
  });

  it("writes the popover's numbers and units", async () => {
    const { formatFahrenheit, formatInchesPerHour } = await onOldEngine();

    expect(formatFahrenheit(-10.4)).toBe(`${MINUS}10.4 \u00b0F`);
    expect(formatInchesPerHour(0.0004)).toBe("0.000 in/hr");
  });

  it("writes the miles, the pounds and the duration of a route", async () => {
    const { formatDuration, formatMiles, formatPounds } = await onOldEngine();

    expect(formatMiles(537.0552)).toBe("537.1 mi");
    expect(formatPounds(38000)).toBe("38,000 lb");
    expect(formatDuration(28666)).toBe("7 h 58 min");
  });

  it("follows the locale's separators, and writes U+2212 even where the locale writes a hyphen", async () => {
    const { formatReading } = await onOldEngine();

    expect(formatReading(-3.5, "temp", { locale: "de-DE" })).toBe(`${MINUS}3,5`);
    expect(formatReading(-0.04, "temp", { locale: "de-DE" })).toBe("0,0");
  });

  it("decides that a number reads zero in the digits of the locale, not only in 0 to 9", async () => {
    const locale = "ar-EG-u-nu-arab";
    const arabic = (value: number): string =>
      new RealNumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
        value,
      );
    const { formatReading } = await onOldEngine();

    // The digits are Arabic-Indic: a check for the character 0 would not see them.
    expect(arabic(3.5)).not.toMatch(/[0-9]/u);
    // A number that rounds to zero is written as zero is: no sign, and no direction mark, which
    // this locale puts before a sign.
    expect(formatReading(-0.04, "temp", { locale })).toBe(arabic(0));
    // Any other negative number keeps its sign, as U+2212. The mark that the engine puts before
    // it is the engine's choice (older ICU keeps it inside the sign), so the head is not pinned.
    const text = formatReading(-3.5, "temp", { locale });
    expect(text).toContain(MINUS);
    expect(text).not.toContain("-");
    expect(text.endsWith(arabic(3.5))).toBe(true);
  });
});
