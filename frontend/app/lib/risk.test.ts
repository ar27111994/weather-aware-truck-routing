import { describe, expect, it } from "vitest";

import { RISK_LEVELS, riskRulesSchema, type RiskRules } from "../api/contract";
import {
  DEFAULT_SAMPLING_INTERVAL_MI,
  LOAD_LIMITS_LB,
  RISK_LEVEL_INFO,
  RISK_RULES,
  SAMPLING_INTERVALS_MI,
  bandLabels,
  classifyFactor,
  compareRiskLevels,
  loadRuleText,
  riskLabel,
  riskLevelInfo,
  riskOrdinal,
} from "./risk";

/** The DOMAIN-CONTRACT §10 boundary tables: [value, expected level]. */
const WIND: [number, string][] = [
  [0, "low"],
  [24.9, "low"],
  [25, "moderate"],
  [34.9, "moderate"],
  [35, "high"],
  [44.9, "high"],
  [45, "severe"],
  [54.9, "severe"],
  [55, "no_travel"],
  [120, "no_travel"],
];
const RAIN: [number, string][] = [
  [0, "low"],
  [0.099, "low"],
  [0.1, "moderate"],
  [0.249, "moderate"],
  [0.25, "high"],
  [0.499, "high"],
  [0.5, "severe"],
  [1, "severe"],
  [1.001, "no_travel"],
];
const SNOW: [number, string][] = [
  [0, "low"],
  [0.499, "low"],
  [0.5, "moderate"],
  [0.999, "moderate"],
  [1, "high"],
  [1.999, "high"],
  [2, "severe"],
  [3, "severe"],
  [3.001, "no_travel"],
];

describe("bundled rules", () => {
  it("parses the shared rules file and orders the level metadata by ordinal", () => {
    expect(RISK_LEVEL_INFO.map((info) => info.id)).toEqual([...RISK_LEVELS]);
    expect(RISK_LEVEL_INFO.map((info) => info.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(RISK_LEVEL_INFO.map((info) => info.label)).toEqual([
      "Low",
      "Moderate",
      "High",
      "Severe",
      "No Travel",
    ]);
  });

  it("exposes the form limits straight from the file (no duplicated numbers)", () => {
    expect(LOAD_LIMITS_LB).toEqual(RISK_RULES.load_limits_lb);
    expect(SAMPLING_INTERVALS_MI).toEqual(RISK_RULES.sampling_intervals_mi);
    expect(DEFAULT_SAMPLING_INTERVAL_MI).toBe(RISK_RULES.default_sampling_interval_mi);
  });
});

describe("level metadata", () => {
  it("looks up label and ordinal by level id", () => {
    expect(riskLevelInfo("severe")).toEqual({ id: "severe", ordinal: 3, label: "Severe" });
    expect(riskOrdinal("no_travel")).toBe(4);
    expect(riskLabel("moderate")).toBe("Moderate");
  });

  it("falls back to the canonical severity order for a level the rules do not define", () => {
    const withoutModerate: RiskRules = {
      ...RISK_RULES,
      levels: RISK_RULES.levels.filter((level) => level.id !== "moderate"),
    };
    expect(riskLevelInfo("moderate", withoutModerate)).toEqual({
      id: "moderate",
      ordinal: 1,
      label: "moderate",
    });
  });

  it("labels the unknown state explicitly instead of calling it low", () => {
    expect(riskLabel(null)).toBe("Unknown");
  });

  it("compares levels by ordinal", () => {
    expect(compareRiskLevels("low", "severe")).toBeLessThan(0);
    expect(compareRiskLevels("severe", "low")).toBeGreaterThan(0);
    expect(compareRiskLevels("high", "high")).toBe(0);
  });

  it("reads rule texts from the file", () => {
    expect(bandLabels("wind")).toEqual(["<25 mph", "25–34", "35–44", "45–54", "≥55 mph"]);
    expect(loadRuleText("LR-2")).toBe("45–54 mph + >30,000 lb → No Travel");
    expect(loadRuleText("LR-9")).toBeNull();
  });
});

describe("classifyFactor against the DOMAIN-CONTRACT boundary tables", () => {
  it.each(WIND)("wind %f mph is %s", (value, level) => {
    expect(classifyFactor("wind", value)).toBe(level);
  });
  it.each(RAIN)("rain %f in/hr is %s", (value, level) => {
    expect(classifyFactor("rain", value)).toBe(level);
  });
  it.each(SNOW)("snow %f in/hr is %s", (value, level) => {
    expect(classifyFactor("snow", value)).toBe(level);
  });

  it("kills float artifacts by quantising (0.1 - 1e-12 is MODERATE, 0.30000000000000004 is MODERATE)", () => {
    expect(classifyFactor("rain", 0.1 - 1e-12)).toBe("moderate");
    expect(classifyFactor("rain", 0.30000000000000004)).toBe("high");
    expect(classifyFactor("rain", 0.09999999999)).toBe("moderate");
    expect(classifyFactor("wind", 24.96)).toBe("moderate");
  });

  it("rounds an exact tie to the even quantised value (24.95 mph is 249.5 tenths -> 250 -> MODERATE)", () => {
    expect(classifyFactor("wind", 24.95)).toBe("moderate");
    expect(classifyFactor("wind", 24.94)).toBe("low");
    expect(classifyFactor("wind", 25.05)).toBe("moderate");
  });

  it.each([[null], [undefined], [Number.NaN], [Number.POSITIVE_INFINITY], [-0.5]])(
    "treats %s as unknown, never as low",
    (value) => {
      expect(classifyFactor("wind", value)).toBeNull();
    },
  );
});

describe("classifyFactor follows the rules it is given", () => {
  const rules: RiskRules = riskRulesSchema.parse({
    ...structuredClone(RISK_RULES),
    factors: {
      ...structuredClone(RISK_RULES.factors),
      wind: {
        ...structuredClone(RISK_RULES.factors.wind),
        bands: [
          { level: "low", max_exclusive: 10 },
          { level: "moderate", min_inclusive: 10, max_exclusive: 20 },
          { level: "high", min_inclusive: 30, max_exclusive: 40 },
          { level: "severe", min_inclusive: 40, max_exclusive: 50 },
          { level: "no_travel", min_exclusive: 50 },
        ],
      },
    },
  });

  it("changing a number in the rules changes the classification", () => {
    expect(classifyFactor("wind", 30, RISK_RULES)).toBe("moderate");
    expect(classifyFactor("wind", 30, rules)).toBe("high");
  });

  it("reports a gap between bands as unknown", () => {
    expect(classifyFactor("wind", 25, rules)).toBeNull();
  });

  it("honours inclusive and exclusive bounds on both sides", () => {
    expect(classifyFactor("wind", 50, rules)).toBeNull();
    expect(classifyFactor("wind", 50.1, rules)).toBe("no_travel");
  });
});
