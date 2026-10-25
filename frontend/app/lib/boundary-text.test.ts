import { describe, expect, it } from "vitest";

import { BOUNDARY_CASES } from "../../test/boundary-cases";
import { closeUpperEdge, validRules } from "../../test/risk-rules-variants";
import { RISK_FACTORS } from "../api/vocabulary";
import { bandEdgesText, boundaryNote, boundaryRule, edgeDecimals } from "./boundary-text";
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
    const everyEdgeClosed = validRules((rules) => {
      for (const factor of RISK_FACTORS) {
        for (const level of ["low", "moderate", "high", "severe"] as const) {
          if (
            rules.factors[factor].bands.some(
              (band) => band.level === level && band.max_exclusive !== undefined,
            )
          ) {
            closeUpperEdge(rules, factor, level);
          }
        }
      }
    });

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
