import { describe, expect, it } from "vitest";

import type { RiskBand, RiskRules } from "../../api/contract";
import { RISK_RULES } from "../../lib/risk";
import {
  bandText,
  boundaryExceptions,
  edgeDecimals,
  loadIntro,
  loadLimits,
  loadRange,
  loadRuleSentences,
  precisionPhrase,
  rankingEntries,
  riskTableRows,
  toleranceSentence,
} from "./rules-text";

function changed(edit: (rules: RiskRules) => void): RiskRules {
  const copy = structuredClone(RISK_RULES);
  edit(copy);
  return copy;
}

const row = (rules: RiskRules, factor: string): string[] | undefined =>
  riskTableRows(rules)
    .find((candidate) => candidate.factor === factor)
    ?.cells.map((cell) => cell.text);

describe("bandText", () => {
  it.each<[string, RiskBand, number, string]>([
    ["a lower band", { level: "low", max_exclusive: 25 }, 0, "under 25"],
    [
      "a middle band",
      { level: "moderate", min_inclusive: 25, max_exclusive: 35 },
      0,
      "25 to under 35",
    ],
    [
      "a band closed at the top",
      { level: "severe", min_inclusive: 0.5, max_inclusive: 1 },
      2,
      "0.50 to 1.00",
    ],
    ["an open top band", { level: "no_travel", min_inclusive: 55 }, 0, "55 or more"],
    [
      "a top band that starts above a number",
      { level: "no_travel", min_exclusive: 1 },
      2,
      "over 1.00",
    ],
  ])("writes %s in words", (_name, band, decimals, text) => {
    expect(bandText(band, decimals)).toBe(text);
  });

  it("refuses a band with no edge, which the rules schema does not allow", () => {
    expect(() => bandText({ level: "low" }, 0)).toThrow("A risk band needs at least one edge.");
  });
});

describe("edgeDecimals", () => {
  it("is the most any edge of the factor needs", () => {
    expect(edgeDecimals(RISK_RULES.factors.wind.bands)).toBe(0);
    expect(edgeDecimals(RISK_RULES.factors.rain.bands)).toBe(2);
    expect(edgeDecimals(RISK_RULES.factors.snow.bands)).toBe(1);
  });

  it("is zero for no bands", () => {
    expect(edgeDecimals([])).toBe(0);
  });
});

describe("riskTableRows", () => {
  it("is the table of the rules file, with every edge printed alike", () => {
    expect(row(RISK_RULES, "wind")).toEqual([
      "under 25",
      "25 to under 35",
      "35 to under 45",
      "45 to under 55",
      "55 or more",
    ]);
    expect(row(RISK_RULES, "rain")).toEqual([
      "under 0.10",
      "0.10 to under 0.25",
      "0.25 to under 0.50",
      "0.50 to 1.00",
      "over 1.00",
    ]);
    expect(row(RISK_RULES, "snow")).toEqual([
      "under 0.5",
      "0.5 to under 1.0",
      "1.0 to under 2.0",
      "2.0 to 3.0",
      "over 3.0",
    ]);
  });

  it("names each row by its factor and unit", () => {
    expect(riskTableRows(RISK_RULES).map((entry) => entry.name)).toEqual([
      "Wind (mph)",
      "Rain (in/hr)",
      "Snow (in/hr)",
    ]);
  });

  it("changes when a number in the rules changes", () => {
    const rules = changed((copy) => {
      const bands = copy.factors.wind.bands;
      const [low, moderate] = bands;
      if (low === undefined || moderate === undefined) throw new Error("wind has no bands");
      low.max_exclusive = 30;
      moderate.min_inclusive = 30;
    });

    expect(row(rules, "wind")?.slice(0, 2)).toEqual(["under 30", "30 to under 35"]);
  });
});

describe("boundaryExceptions", () => {
  it("names the values that stay in their band exactly on its upper edge", () => {
    expect(boundaryExceptions(RISK_RULES)).toBe(
      "rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr",
    );
  });

  it("follows the rules file", () => {
    const rules = changed((copy) => {
      const severe = copy.factors.snow.bands.find((band) => band.level === "severe");
      if (severe?.max_inclusive === undefined) throw new Error("snow has no closed band");
      severe.max_inclusive = 4;
    });

    expect(boundaryExceptions(rules)).toBe(
      "rain at exactly 1.00 in/hr and snow at exactly 4.0 in/hr",
    );
  });
});

describe("load rules", () => {
  it("writes every rule as a sentence, in the order of the rules file", () => {
    expect(loadRuleSentences(RISK_RULES)).toEqual([
      "LR-1: wind of 55 mph or more is No Travel for any load.",
      "LR-2: wind from 45 to under 55 mph with a load over 30,000 lb is No Travel.",
      "LR-3: wind from 35 to under 45 mph with a load over 40,000 lb is Severe.",
    ]);
  });

  it("changes with the rules", () => {
    const rules = changed((copy) => {
      const rule = copy.load_rules.find((candidate) => candidate.id === "LR-2");
      if (rule === undefined) throw new Error("no LR-2");
      rule.load_lb_min_exclusive = 32_000;
    });

    expect(loadRuleSentences(rules)[1]).toContain("a load over 32,000 lb");
  });

  it("lists the weights a load has to be over, smallest first, once each", () => {
    expect(loadLimits(RISK_RULES)).toBe("30,000 lb and 40,000 lb".replaceAll(" lb", ""));
  });

  it("has no limits when no rule has a weight", () => {
    const rules = changed((copy) => {
      for (const rule of copy.load_rules) rule.load_lb_min_exclusive = null;
    });

    expect(loadLimits(rules)).toBeNull();
  });

  it("names a level by its id when the rules file does not list it", () => {
    const rules = changed((copy) => {
      copy.levels = copy.levels.filter((level) => level.id !== "no_travel");
    });

    expect(loadRuleSentences(rules)[0]).toBe(
      "LR-1: wind of 55 mph or more is no_travel for any load.",
    );
  });

  it("says what routing assumes about the truck and what loads are accepted", () => {
    expect(loadIntro(RISK_RULES)).toContain("gross weight of 35,000 lb");
    expect(loadRange(RISK_RULES)).toBe("Loads from 0 to 80,000 lb are accepted.");
  });
});

describe("precisionPhrase", () => {
  it("says how far each factor is rounded", () => {
    expect(precisionPhrase(RISK_RULES)).toBe(
      "wind is rounded to 0.1 mph, rain to 0.001 in/hr, and snow to 0.001 in/hr",
    );
  });
});

describe("rankingEntries", () => {
  it("is the keys of the rules file in order, in words", () => {
    expect(rankingEntries(RISK_RULES).map((entry) => entry.text)).toEqual([
      "Fewest No Travel miles",
      "Most complete weather data",
      "Fewest Severe miles",
      "Fewest High miles",
      "Lowest average risk",
      "Shortest travel time",
    ]);
  });

  it("stops at a key it has no words for rather than leave it out", () => {
    const rules = changed((copy) => {
      copy.ranking.keys.push("distance_mi");
    });

    expect(() => rankingEntries(rules)).toThrow('The ranking key "distance_mi" has no words');
  });
});

describe("toleranceSentence", () => {
  it("names the differences that do not decide a ranking", () => {
    expect(toleranceSentence(RISK_RULES)).toBe(
      "Differences smaller than 0.1 mi, 0.001 in average risk or 1 s do not decide a ranking.",
    );
  });
});
