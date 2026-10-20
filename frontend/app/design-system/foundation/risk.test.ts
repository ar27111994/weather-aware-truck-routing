import { describe, expect, it } from "vitest";

import rules from "../../../../shared/risk-rules.json";
import { tokens } from "../tokens/tokens";
import { RISK_LEVELS, compareRisk, riskInfo, riskVar } from "./risk";
import type { RiskKey } from "./risk";

const ALL_KEYS: readonly RiskKey[] = [...RISK_LEVELS, "unknown"];

describe("riskInfo", () => {
  it.each(rules.levels)(
    "names $id exactly as shared/risk-rules.json does",
    ({ id, ordinal, label }) => {
      // An id the system does not know comes back as Unknown, so `key` below fails on drift.
      const info = riskInfo(RISK_LEVELS.find((level) => level === id));

      expect(info.label).toBe(label);
      expect(info.ordinal).toBe(ordinal);
      expect(info.key).toBe(id);
    },
  );

  it("treats null and undefined as Unknown, sorted before every scored level", () => {
    expect(riskInfo(null)).toMatchObject({ key: "unknown", label: "Unknown", ordinal: -1 });
    expect(riskInfo(undefined)).toEqual(riskInfo(null));
  });

  it("gives every level its own icon and its own pattern, so colour is never the only cue", () => {
    const infos = ALL_KEYS.map((key) => riskInfo(key === "unknown" ? null : key));

    expect(new Set(infos.map((info) => info.icon)).size).toBe(6);
    expect(new Set(infos.map((info) => info.pattern)).size).toBe(6);
  });

  it("orders the scored levels by severity", () => {
    const ordinals = RISK_LEVELS.map((level) => riskInfo(level).ordinal);

    expect(ordinals).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("compareRisk (R1-34)", () => {
  const SCRAMBLED = [null, "high", "low", null, "no_travel", "severe", "moderate"] as const;
  const names = (levels: readonly (RiskKey | null)[]): string[] =>
    levels.map((level) => level ?? "unknown");

  it("sorts Low to No Travel and puts Unknown last", () => {
    const sorted = SCRAMBLED.toSorted((left, right) => compareRisk(left, right));

    expect(names(sorted)).toEqual([
      "low",
      "moderate",
      "high",
      "severe",
      "no_travel",
      "unknown",
      "unknown",
    ]);
  });

  it("sorts No Travel to Low when descending, and still puts Unknown last", () => {
    const sorted = SCRAMBLED.toSorted((left, right) => compareRisk(left, right, "descending"));

    expect(names(sorted)).toEqual([
      "no_travel",
      "severe",
      "high",
      "moderate",
      "low",
      "unknown",
      "unknown",
    ]);
  });

  it("treats null and undefined alike, and equal levels as equal", () => {
    expect(compareRisk(null, undefined)).toBe(0);
    expect(compareRisk("high", "high")).toBe(0);
    expect(compareRisk(undefined, "low")).toBeGreaterThan(0);
    expect(compareRisk("low", undefined, "descending")).toBeLessThan(0);
  });
});

describe("riskVar", () => {
  it.each(ALL_KEYS)("points %s at design tokens that exist in both themes", (key) => {
    const level = key === "unknown" ? null : key;

    for (const part of ["fill", "on-fill", "stroke"] as const) {
      const variable = riskVar(level, part);
      const name = variable.slice("var(--".length, -1);

      expect(tokens.light).toHaveProperty([name]);
      expect(tokens.dark).toHaveProperty([name]);
    }
  });

  it("spells no_travel with a hyphen in token names", () => {
    expect(riskVar("no_travel", "fill")).toBe("var(--risk-no-travel-fill)");
  });
});
