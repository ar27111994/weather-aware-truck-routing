import { describe, expect, it } from "vitest";

import type { Checkpoint, Plan } from "../../api/contract";
import { minimalPlan } from "../../api/mocks";
import { at } from "../../lib/checked";
import { RISK_RULES } from "../../lib/risk";
import { checkpointDetails } from "./checkpoint-details";

/** The minimal plan with route B's second checkpoint replaced by `overrides`. */
function planWithCheckpoint(overrides: Partial<Checkpoint>, loadLb = 38_000): Plan {
  const plan = structuredClone(minimalPlan());
  const route = at(plan.routes, 0);
  const second = at(route.checkpoints, 1);
  route.checkpoints[1] = { ...second, ...overrides };
  return { ...plan, request: { ...plan.request, load_weight_lb: loadLb } };
}

const LATER = {
  index: 1,
  eta: "2026-10-20T17:20:00Z",
  distance_mi: 175,
  owned_mi: 25,
  utc_offset_s: -21_600,
  timezone: "America/Denver",
} as const;

describe("checkpointDetails (DESIGN.md section 9.7)", () => {
  it("writes the header, ETA, offset, distance and every factor of a checkpoint", () => {
    const plan = planWithCheckpoint({
      ...LATER,
      weather: {
        valid_time: "2026-10-20T17:00:00Z",
        wind_mph: 27.4,
        gust_mph: 38,
        rain_in_hr: 0.012,
        snow_in_hr: 0,
        temperature_f: 41.2,
        weather_code: 3,
      },
      risk: {
        level: "moderate",
        factors: { wind: "moderate", rain: "low", snow: "low" },
        load_rule: null,
        incomplete: false,
        reasons: ["Wind 27.4 mph (Moderate)"],
      },
    });

    const details = checkpointDetails(plan, { routeId: "B", index: 1 }, "en-US");

    expect(details).toEqual({
      routeId: "B",
      title: "Checkpoint 2 of 2",
      level: "moderate",
      eta: "Tue 11:20 AM MDT",
      offset: "UTC\u22126",
      afterDeparture: "+3 h 20 min after departure",
      distance: "175.0 mi from origin, covers 25.0 mi",
      rows: [
        { key: "wind", label: "Wind", value: "27.4 mph", level: "moderate" },
        {
          key: "gust",
          label: "Gusts",
          value: "38.0 mph",
          note: "not scored (sustained wind is scored)",
        },
        { key: "rain", label: "Rain", value: "0.012 in/hr", level: "low" },
        { key: "snow", label: "Snow", value: "0.00 in/hr", level: "low" },
        { key: "temp", label: "Temp", value: "41\u00b0F" },
      ],
      loadRule: "None",
      reasons: ["Wind 27.4 mph (Moderate)"],
      validFor: "Forecast for Tue 11:00 AM MDT.",
      incomplete: null,
    });
  });

  it("says At departure for the first checkpoint", () => {
    expect(checkpointDetails(minimalPlan(), { routeId: "B", index: 0 })?.afterDeparture).toBe(
      "At departure",
    );
  });

  it("names the load rule that raised the level, in the rules file's words", () => {
    const plan = planWithCheckpoint({
      ...LATER,
      risk: {
        ...at(at(minimalPlan().routes, 0).checkpoints, 1).risk,
        level: "severe",
        load_rule: "LR-3",
      },
    });

    expect(checkpointDetails(plan, { routeId: "B", index: 1 })?.loadRule).toBe(
      `LR-3: ${String(RISK_RULES.load_rules.find((rule) => rule.id === "LR-3")?.brief_text)}`,
    );
  });

  it("falls back to the rule id for a rule the bundled rules do not know", () => {
    const plan = planWithCheckpoint({
      risk: { ...at(at(minimalPlan().routes, 0).checkpoints, 1).risk, load_rule: "LR-9" },
    });

    expect(checkpointDetails(plan, { routeId: "B", index: 1 })?.loadRule).toBe("LR-9: LR-9");
  });

  it("notes a near miss: the wind is in a rule's band but the load is under its threshold", () => {
    const windy = (wind: number): Partial<Checkpoint> => ({
      weather: { ...at(at(minimalPlan().routes, 0).checkpoints, 1).weather, wind_mph: wind },
    });

    expect(
      checkpointDetails(planWithCheckpoint(windy(38), 25_000), { routeId: "B", index: 1 }, "en-US")
        ?.loadRule,
    ).toBe("None. LR-3 applies only above 40,000 lb; this load is 25,000 lb.");
    expect(
      checkpointDetails(planWithCheckpoint(windy(47), 30_000), { routeId: "B", index: 1 })
        ?.loadRule,
    ).toBe("None. LR-2 applies only above 30,000 lb; this load is 30,000 lb.");
    expect(
      checkpointDetails(planWithCheckpoint(windy(20), 25_000), { routeId: "B", index: 1 })
        ?.loadRule,
    ).toBe("None");
  });

  it("checks a rule with no upper wind bound too", () => {
    const rules = structuredClone(RISK_RULES);
    rules.load_rules = [
      {
        id: "LR-X",
        factor: "wind",
        min_inclusive: 30,
        load_lb_min_exclusive: 50_000,
        result: "severe",
        brief_text: "x",
      },
    ];
    const plan = planWithCheckpoint({
      weather: { ...at(at(minimalPlan().routes, 0).checkpoints, 1).weather, wind_mph: 90 },
    });

    expect(checkpointDetails(plan, { routeId: "B", index: 1 }, undefined, rules)?.loadRule).toBe(
      "None. LR-X applies only above 50,000 lb; this load is 38,000 lb.",
    );
  });

  it("shows missing values as No data and names the factors an incomplete checkpoint lacks", () => {
    const base = at(at(minimalPlan().routes, 0).checkpoints, 1);
    const plan = planWithCheckpoint({
      weather: {
        ...base.weather,
        wind_mph: null,
        gust_mph: null,
        rain_in_hr: null,
        snow_in_hr: null,
        temperature_f: null,
      },
      risk: {
        ...base.risk,
        level: null,
        factors: { wind: null, rain: "low", snow: null },
        incomplete: true,
      },
    });

    const details = checkpointDetails(plan, { routeId: "B", index: 1 });

    expect(details?.rows.map((row) => row.value)).toEqual([
      "No data",
      "No data",
      "No data",
      "No data",
      "No data",
    ]);
    expect(details?.incomplete).toBe("Incomplete data: Wind, Snow");
    expect(details?.loadRule).toBe("None");
  });

  it("is null for a checkpoint or route the plan does not have", () => {
    expect(checkpointDetails(minimalPlan(), { routeId: "B", index: 99 })).toBeNull();
    expect(checkpointDetails(minimalPlan(), { routeId: "Z", index: 0 })).toBeNull();
  });
});
