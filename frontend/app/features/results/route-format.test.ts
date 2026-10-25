import { describe, expect, it } from "vitest";

import { at } from "../../lib/checked";
import { formatFahrenheit, formatInchesPerHour, formatMph } from "../../lib/format";
import { planFor } from "../../../test/plans";
import {
  arrivalClock,
  averageRiskText,
  checkpointClock,
  departureClock,
  milesByLevel,
  routeCardLabel,
  weatherValue,
} from "./route-format";

const plan = planFor("mixed");
const recommended = at(plan.routes, 0);
const other = at(plan.routes, 1);

describe("checkpointClock", () => {
  it("writes the ETA on the clock of the checkpoint's own zone, with the zone's name", () => {
    const origin = at(recommended.checkpoints, 0);

    // The fixture departs 14:00 UTC from Salt Lake City, which is on MDT (UTC-6).
    expect(checkpointClock(origin, "en-US")).toBe("Tue 8:00 AM MDT");
  });

  it("follows the user's locale (en-GB: 24-hour clock, zone as an offset)", () => {
    const origin = at(recommended.checkpoints, 0);

    expect(checkpointClock(origin, "en-GB")).toMatch(/^Tue,? 08:00 UTC.6$/u);
  });
});

describe("arrivalClock and departureClock", () => {
  it("put the arrival on the destination's clock and the departure on the origin's", () => {
    const arrival = arrivalClock(recommended, "en-US");
    const departure = departureClock(recommended, "en-US");

    expect(departure).toBe("Tue 8:00 AM MDT");
    expect(arrival).toMatch(/^(Tue|Wed) \d{1,2}:\d{2} (AM|PM) MDT$/u);
  });
});

describe("milesByLevel", () => {
  it("is the route's miles at each level plus its unknown miles", () => {
    const miles = milesByLevel(recommended);

    expect(miles).toEqual({
      ...recommended.stats.miles_by_level,
      unknown: recommended.stats.unknown_mi,
    });
  });
});

describe("routeCardLabel", () => {
  it("names the route, the distance, the drive time and the highest level", () => {
    const label = routeCardLabel(other);

    expect(label).toContain(`Route ${other.route_id}, `);
    expect(label).not.toContain("recommended");
    expect(label).toMatch(
      /, [\d,]+\.\d miles, \d+ h( \d+ min)?, highest risk (Low|Moderate|High|Severe|No Travel|Unknown)$/u,
    );
  });

  it("says recommended for the recommended route", () => {
    expect(routeCardLabel(recommended)).toContain(`Route ${recommended.route_id}, recommended, `);
  });

  it("says Unknown, never Low, when no checkpoint was assessed", () => {
    const blind = { ...other, stats: { ...other.stats, max_level: null } };

    expect(routeCardLabel(blind)).toMatch(/highest risk Unknown$/u);
  });
});

describe("averageRiskText", () => {
  it("shows the average at the three decimals the ranking compares", () => {
    const route = { ...recommended, stats: { ...recommended.stats, avg_risk: 0.0625 } };

    expect(averageRiskText(route)).toBe("0.063");
  });

  it("shows Unknown when nothing was assessed", () => {
    const route = { ...recommended, stats: { ...recommended.stats, avg_risk: null } };

    expect(averageRiskText(route)).toBe("Unknown");
  });
});

describe("weatherValue", () => {
  it("shows wind and gusts to a tenth", () => {
    expect(weatherValue(12.34, "wind", "en-US")).toBe("12.3");
    expect(weatherValue(21, "gust", "en-US")).toBe("21.0");
  });

  it("shows rain and snow to a thousandth, the precision the domain classifies them at", () => {
    expect(weatherValue(0.1, "rain", "en-US")).toBe("0.100");
    expect(weatherValue(0.2504, "snow", "en-US")).toBe("0.250");
  });

  it("shows rain to a thousandth even when two decimals would end in a zero", () => {
    expect(weatherValue(0.62, "rain", "en-US")).toBe("0.620");
  });

  // DESIGN.md section 2: temperature is 1 dp. Whole degrees hid the freezing line: 31.6 and 32.4
  // both read 32, and that is the difference between ice on the road and a wet road.
  it("shows temperature to a tenth", () => {
    expect(weatherValue(48.2, "temp", "en-US")).toBe("48.2");
  });

  it("tells 31.6 and 32.4 apart, either side of the freezing line", () => {
    expect(weatherValue(31.6, "temp", "en-US")).toBe("31.6");
    expect(weatherValue(32.4, "temp", "en-US")).toBe("32.4");
  });

  it("writes a negative temperature with U+2212, never a hyphen-minus", () => {
    const text = weatherValue(-3.6, "temp", "en-US");

    expect(text).toBe("\u22123.6");
    expect(text.codePointAt(0)).toBe(0x2212);
    expect(text.includes("-")).toBe(false);
    expect(weatherValue(-0.4, "temp", "en-US")).toBe("\u22120.4");
  });

  it("writes no sign for a temperature that rounds to zero", () => {
    expect(weatherValue(-0.04, "temp", "en-US")).toBe("0.0");
  });

  it("says No data for a missing reading, never zero", () => {
    expect(weatherValue(null, "wind", "en-US")).toBe("No data");
  });

  it("follows the user's number conventions, but writes the minus the design asks for", () => {
    expect(weatherValue(12.3, "wind", "de-DE")).toBe("12,3");
    expect(weatherValue(-3.5, "temp", "de-DE")).toBe("\u22123,5");
  });

  it("refuses a reading that is not a number, as the popover does", () => {
    expect(() => weatherValue(Number.NaN, "temp", "en-US")).toThrow(RangeError);
    expect(() => weatherValue(Number.POSITIVE_INFINITY, "wind", "en-US")).toThrow(RangeError);
  });
});

// D-59: the checkpoint popover (number and unit) and the table cell (number only) show the same
// reading. They share one digit rule (lib/reading.ts), so for the same value the popover's text is
// the table's text and the unit, character for character: the digits, the decimal mark and the sign.
describe("a reading in the popover and in the table", () => {
  const RAIN_AND_SNOW = [0, 0.0004, 0.012, 0.62, 0.2496];
  const SPEEDS = [0, 12.34, 27.4, 38];
  const CASES = [
    {
      reading: "temp",
      popover: formatFahrenheit,
      unit: "\u00b0F",
      values: [48.2, 31.6, 32.4, -0.04, -0.4, -3.6, -10.4],
    },
    { reading: "rain", popover: formatInchesPerHour, unit: "in/hr", values: RAIN_AND_SNOW },
    { reading: "snow", popover: formatInchesPerHour, unit: "in/hr", values: RAIN_AND_SNOW },
    { reading: "wind", popover: formatMph, unit: "mph", values: SPEEDS },
    { reading: "gust", popover: formatMph, unit: "mph", values: SPEEDS },
  ] as const;

  describe.each(CASES)("$reading", ({ reading, popover, unit, values }) => {
    it.each(["en-US", "de-DE"])("gives the same text in %s", (locale) => {
      for (const value of values) {
        expect(popover(value, { locale })).toBe(`${weatherValue(value, reading, locale)} ${unit}`);
      }
    });
  });
});
