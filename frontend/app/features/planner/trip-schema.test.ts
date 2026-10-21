import { describe, expect, it } from "vitest";

import { SAMPLING_INTERVALS_MI } from "../../api/contract";
import { t } from "../../design-system/foundation/strings";
import { RISK_RULES } from "../../lib/risk";
import {
  DEPARTURE_GRACE_MINUTES,
  DEPARTURE_WINDOW_HOURS,
  departureBounds,
  validateTrip,
  type TripDraft,
} from "./trip-schema";

const NOW = new Date("2026-10-20T12:00:00Z");
const SLC = { lat: 40.7608, lon: -111.891, label: "Salt Lake City, Utah, United States" };
const DENVER = { lat: 39.7392, lon: -104.9903, label: "Denver, Colorado, United States" };

function draft(overrides: Partial<TripDraft> = {}): TripDraft {
  return {
    origin: SLC,
    destination: DENVER,
    departure: new Date("2026-10-20T14:00:00Z"),
    load: 38_000,
    interval: 25,
    scenario: null,
    ...overrides,
  };
}

function errorsOf(overrides: Partial<TripDraft>, rules = RISK_RULES): Record<string, string> {
  const result = validateTrip(draft(overrides), NOW, rules);
  if (result.ok) throw new Error("expected the draft to be rejected");
  return result.errors;
}

describe("validateTrip: a valid trip", () => {
  it("becomes the exact POST /plans body", () => {
    expect(validateTrip(draft(), NOW)).toEqual({
      ok: true,
      request: {
        origin: SLC,
        destination: DENVER,
        departure_time: "2026-10-20T14:00:00Z",
        load_weight_lb: 38_000,
        sampling_interval_mi: 25,
        scenario: null,
      },
    });
  });

  it("drops seconds and milliseconds from the departure (the API keys plans by the minute)", () => {
    const result = validateTrip(draft({ departure: new Date("2026-10-20T14:00:42.789Z") }), NOW);

    expect(result).toMatchObject({ ok: true, request: { departure_time: "2026-10-20T14:00:00Z" } });
  });

  it("carries a chosen scenario to the request", () => {
    const result = validateTrip(draft({ scenario: "severe-on-fastest" }), NOW);

    expect(result).toMatchObject({ ok: true, request: { scenario: "severe-on-fastest" } });
  });

  it("accepts every checkpoint interval the API accepts", () => {
    for (const interval of SAMPLING_INTERVALS_MI) {
      expect(validateTrip(draft({ interval }), NOW)).toMatchObject({
        ok: true,
        request: { sampling_interval_mi: interval },
      });
    }
  });

  it("accepts the edges of the load range, 0 and 80,000 lb", () => {
    expect(validateTrip(draft({ load: 0 }), NOW).ok).toBe(true);
    expect(validateTrip(draft({ load: 80_000 }), NOW).ok).toBe(true);
  });
});

describe("validateTrip: places", () => {
  it("asks for both places when neither was chosen from the list", () => {
    expect(errorsOf({ origin: null, destination: null })).toEqual({
      origin: t("form.origin.error.required"),
      destination: t("form.destination.error.required"),
    });
  });

  it("rejects a destination under one mile from the origin and says so on the destination", () => {
    // 0.0144 degrees of latitude is 0.995 miles.
    const next = { ...SLC, lat: SLC.lat + 0.0144, label: "Next door" };

    expect(errorsOf({ destination: next })).toEqual({
      destination: t("form.destination.error.tooClose"),
    });
  });

  it("accepts a destination just over one mile away", () => {
    // 0.0146 degrees of latitude is 1.009 miles.
    const next = { ...SLC, lat: SLC.lat + 0.0146, label: "Next door" };

    expect(validateTrip(draft({ destination: next }), NOW).ok).toBe(true);
  });

  it("rejects a place whose label is empty or longer than the API's 200 characters", () => {
    expect(errorsOf({ origin: { ...SLC, label: "" } })).toHaveProperty("origin");
    expect(errorsOf({ destination: { ...DENVER, label: "x".repeat(201) } })).toHaveProperty(
      "destination",
    );
    expect(validateTrip(draft({ origin: { ...SLC, label: "x".repeat(200) } }), NOW).ok).toBe(true);
  });

  it("rejects coordinates outside the globe", () => {
    expect(errorsOf({ origin: { ...SLC, lat: 91 } })).toHaveProperty("origin");
    expect(errorsOf({ destination: { ...DENVER, lon: -181 } })).toHaveProperty("destination");
  });
});

describe("validateTrip: departure", () => {
  it("asks for a departure while the date or time is empty or not a real instant", () => {
    const expected = { departure: t("form.departure.error.required") };

    expect(errorsOf({ departure: null })).toEqual(expected);
    expect(errorsOf({ departure: new Date(Number.NaN) })).toEqual(expected);
  });

  it("accepts the last 15 minutes and rejects anything older", () => {
    const edge = new Date(NOW.getTime() - DEPARTURE_GRACE_MINUTES * 60_000);
    const before = new Date(edge.getTime() - 60_000);

    expect(validateTrip(draft({ departure: edge }), NOW).ok).toBe(true);
    expect(errorsOf({ departure: before })).toEqual({
      departure: t("form.departure.error.range"),
    });
  });

  it("accepts up to 120 hours ahead and rejects anything later", () => {
    const edge = new Date(NOW.getTime() + DEPARTURE_WINDOW_HOURS * 3_600_000);
    const after = new Date(edge.getTime() + 60_000);

    expect(validateTrip(draft({ departure: edge }), NOW).ok).toBe(true);
    expect(errorsOf({ departure: after })).toEqual({ departure: t("form.departure.error.range") });
  });
});

describe("validateTrip: load", () => {
  it("asks for the load while the field is empty (NaN)", () => {
    expect(errorsOf({ load: Number.NaN })).toEqual({ load: t("form.load.error.required") });
  });

  it("asks for whole pounds", () => {
    expect(errorsOf({ load: 38_000.5 })).toEqual({ load: t("form.load.error.integer") });
  });

  it("keeps the load inside the range the rules file declares, edge by edge", () => {
    expect(errorsOf({ load: -1 })).toEqual({ load: t("form.load.error.range") });
    expect(errorsOf({ load: 80_001 })).toEqual({ load: t("form.load.error.range") });
  });

  it("follows a different range when the rules file declares one (thresholds are data)", () => {
    const rules = { ...RISK_RULES, load_limits_lb: { min: 1_000, max: 50_000 } };

    expect(errorsOf({ load: 500 }, rules)).toEqual({ load: t("form.load.error.range") });
    expect(errorsOf({ load: 60_000 }, rules)).toEqual({ load: t("form.load.error.range") });
    expect(validateTrip(draft({ load: 1_000 }), NOW, rules).ok).toBe(true);
  });
});

describe("validateTrip: interval", () => {
  it("rejects an interval the API does not offer", () => {
    const invalid = { ...draft(), interval: 15 } as unknown as TripDraft;
    const result = validateTrip(invalid, NOW);

    expect(result).toEqual({ ok: false, errors: { interval: t("form.interval.error") } });
  });
});

describe("validateTrip: several problems at once", () => {
  it("reports every field once, in the form's own words", () => {
    const result = validateTrip(draft({ origin: null, departure: null, load: Number.NaN }), NOW);

    expect(result).toEqual({
      ok: false,
      errors: {
        origin: t("form.origin.error.required"),
        departure: t("form.departure.error.required"),
        load: t("form.load.error.required"),
      },
    });
  });
});

describe("departureBounds", () => {
  it("is the API's window: 15 minutes back to 120 hours ahead", () => {
    const { earliest, latest } = departureBounds(NOW);

    expect(earliest.toISOString()).toBe("2026-10-20T11:45:00.000Z");
    expect(latest.toISOString()).toBe("2026-10-25T12:00:00.000Z");
  });
});
