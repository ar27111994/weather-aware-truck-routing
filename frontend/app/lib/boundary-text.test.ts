import { describe, expect, it } from "vitest";

import { BOUNDARY_CASES, closedEverywhere } from "../../test/boundary-cases";
import {
  closeUpperEdge,
  moveUpperEdge,
  openUpperEdge,
  validRules,
} from "../../test/risk-rules-variants";
import { RISK_FACTORS } from "../api/vocabulary";
import {
  bandEdgesText,
  bandWords,
  boundaryNote,
  boundaryRule,
  edgeDecimals,
} from "./boundary-text";
import { RISK_RULES, classifyFactor } from "./risk";

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

describe("the boundary sentences (RT-F2)", () => {
  it.each(BOUNDARY_CASES)("$name: the boundary rule of the page", ({ rules, rule }) => {
    expect(boundaryRule(rules)).toBe(rule);
  });

  it.each(BOUNDARY_CASES)("$name: the footnote of the map legend", ({ rules, note }) => {
    expect(boundaryNote(rules)).toBe(note);
  });

  it.each(BOUNDARY_CASES)("$name: where one band ends and the next begins", ({ rules, edges }) => {
    expect(bandEdgesText(rules)).toBe(edges);
  });

  it.each(BOUNDARY_CASES)(
    "$name: a value on an edge is said to stay in its band if and only if the engine keeps it there",
    ({ rules }) => {
      const texts = [boundaryRule(rules), boundaryNote(rules)];
      for (const factor of RISK_FACTORS) {
        const { label, bands } = rules.factors[factor];
        const decimals = edgeDecimals(bands);
        for (const band of bands) {
          const edge = band.max_inclusive ?? band.max_exclusive;
          if (edge === undefined) continue;
          const stays = classifyFactor(factor, edge, rules) === band.level;
          const phrase = `${label.toLowerCase()} at exactly ${edge.toFixed(decimals)}`;
          for (const text of texts) expect(text.includes(phrase), `${phrase}: ${text}`).toBe(stays);
        }
      }
    },
  );

  it("takes the example from the first edge that a band includes, and leaves it out when none does", () => {
    const everyEdgeClosed = closedEverywhere();

    const text = bandEdgesText(everyEdgeClosed);

    expect(text).not.toContain("Each band includes its lower number");
    expect(text).toBe(
      "Wind at exactly 25 mph, rain at exactly 0.10 in/hr, and snow at exactly 0.5 in/hr stay Low. " +
        "Wind at exactly 35 mph, rain at exactly 0.25 in/hr, and snow at exactly 1.0 in/hr stay Moderate. " +
        "Wind at exactly 45 mph, rain at exactly 0.50 in/hr, and snow at exactly 2.0 in/hr stay High. " +
        "Wind at exactly 55 mph, rain at exactly 1.00 in/hr, and snow at exactly 3.0 in/hr stay Severe.",
    );
    expect(boundaryRule(everyEdgeClosed)).toBe(
      "Each band includes its lower number. A value exactly on a boundary belongs to the higher band, " +
        "except wind at exactly 25 mph, rain at exactly 0.10 in/hr, and snow at exactly 0.5 in/hr, which stay Low, " +
        "wind at exactly 35 mph, rain at exactly 0.25 in/hr, and snow at exactly 1.0 in/hr, which stay Moderate, " +
        "wind at exactly 45 mph, rain at exactly 0.50 in/hr, and snow at exactly 2.0 in/hr, which stay High, " +
        "and wind at exactly 55 mph, rain at exactly 1.00 in/hr, and snow at exactly 3.0 in/hr, which stay Severe.",
    );
  });
});

describe("the example of the band edges (RT-F2)", () => {
  it("is looked for in the next factor when wind has no edge that a band includes", () => {
    const windClosed = validRules((rules) => {
      for (const level of ["low", "moderate", "high", "severe"] as const) {
        closeUpperEdge(rules, "wind", level);
      }
    });

    expect(bandEdgesText(windClosed)).toBe(
      "Each band includes its lower number, so 0.100 in/hr is Moderate and 0.099 in/hr is Low. " +
        "Wind at exactly 25 mph stays Low. Wind at exactly 35 mph stays Moderate. " +
        "Wind at exactly 45 mph stays High. " +
        "Wind at exactly 55 mph, rain at exactly 1.00 in/hr, and snow at exactly 3.0 in/hr stay Severe.",
    );
  });
});

describe("the words of the legend's ramp (RT-F4)", () => {
  it("are the five bands of each factor in today's rules, with the unit on the two open ends", () => {
    expect(bandWords("wind", RISK_RULES)).toEqual([
      "under 25 mph",
      "25 to under 35",
      "35 to under 45",
      "45 to under 55",
      "55 mph or more",
    ]);
    expect(bandWords("rain", RISK_RULES)).toEqual([
      "under 0.10 in/hr",
      "0.10 to under 0.25",
      "0.25 to under 0.50",
      "0.50 to 1.00",
      "over 1.00 in/hr",
    ]);
    expect(bandWords("snow", RISK_RULES)).toEqual([
      "under 0.5 in/hr",
      "0.5 to under 1.0",
      "1.0 to under 2.0",
      "2.0 to 3.0",
      "over 3.0 in/hr",
    ]);
  });

  it("follow the edges, the unit and the decimals of the rules they are given", () => {
    const moved = validRules((rules) => {
      moveUpperEdge(rules, "wind", "low", 27.5);
      rules.factors.wind.unit = "km/h";
    });

    expect(bandWords("wind", moved)).toEqual([
      "under 27.5 km/h",
      "27.5 to under 35.0",
      "35.0 to under 45.0",
      "45.0 to under 55.0",
      "55.0 km/h or more",
    ]);
  });

  it("say which side of an edge a band includes, as the rules write it", () => {
    const lowClosed = validRules((rules) => {
      closeUpperEdge(rules, "wind", "low");
    });
    const severeClosed = validRules((rules) => {
      closeUpperEdge(rules, "wind", "severe");
    });
    const rainOpen = validRules((rules) => {
      openUpperEdge(rules, "rain", "severe");
    });

    expect(bandWords("wind", lowClosed)).toEqual([
      "25 mph or less",
      "over 25 to under 35",
      "35 to under 45",
      "45 to under 55",
      "55 mph or more",
    ]);
    expect(bandWords("wind", severeClosed)).toEqual([
      "under 25 mph",
      "25 to under 35",
      "35 to under 45",
      "45 to 55",
      "over 55 mph",
    ]);
    expect(bandWords("rain", rainOpen)).toEqual([
      "under 0.10 in/hr",
      "0.10 to under 0.25",
      "0.25 to under 0.50",
      "0.50 to under 1.00",
      "1.00 in/hr or more",
    ]);
  });
});
