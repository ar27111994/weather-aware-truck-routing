/**
 * The cases of the boundary sentences (RT-F2): rules files that the engine accepts (`validRules`)
 * and, for each, the three sentences that say where a value exactly on the edge of a band goes.
 * Shared by the test of the sentences (`app/lib/boundary-text.test.ts`) and by the test of a file
 * that carries them (the llms-full.txt checks of `app/features/methodology/rules-text.test.ts`):
 * a lib test may not import a feature (D-61), so the table cannot live in either test.
 */
import type { RiskRules } from "../app/api/contract";
import { RISK_FACTORS } from "../app/api/vocabulary";
import {
  closeUpperEdge,
  moveUpperEdge,
  openUpperEdge,
  relabel,
  validRules,
} from "./risk-rules-variants";

// ---- The boundary sentences (RT-F2) ----------------------------------------------------------
//
// Three public strings say where a value exactly on the edge of a band goes: the methodology page's
// boundary rule (and so its markdown and llms-full.txt), the map legend's footnote and the "where
// one band ends" choice. Every number, band name and variable name in them is read from the rules.
// Each case below is a rules file the engine accepts (`validRules`) that fixed words would state
// wrongly.

const RULE_LEAD =
  "Each band includes its lower number. A value exactly on a boundary belongs to the higher band";
const NOTE_LEAD = "A value on a boundary belongs to the higher band";
const EDGES_LEAD = "Each band includes its lower number, so ";
const TODAY_EXAMPLE = `${EDGES_LEAD}25.0 mph is Moderate and 24.9 mph is Low.`;
// Assumption D-01 (RT-F4) names only the edges that the brief does not write as open ranges:
// "No Travel > 1.00" is the brief's own word, so today's rules have no exception to state.
const D01_LEAD = "Each band includes its lower number";
const TODAY_D01 = `${D01_LEAD} (D-01).`;
const TODAY_SEVERE_SENTENCE =
  "Rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr stay Severe, because the brief calls " +
  "No Travel anything over those values.";

export interface BoundaryCase {
  readonly name: string;
  readonly rules: RiskRules;
  /** The boundary rule of the methodology page. */
  readonly rule: string;
  /** The footnote of the map legend. */
  readonly note: string;
  /** The "where one band ends and the next begins" choice. */
  readonly edges: string;
  /** Assumption D-01 of the methodology page (RT-F4). */
  readonly lowerNumber: string;
}

export const BOUNDARY_CASES: readonly BoundaryCase[] = [
  {
    name: "today's rules",
    lowerNumber: TODAY_D01,
    rules: validRules(() => undefined),
    rule: `${RULE_LEAD}, except rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr, which stay Severe.`,
    note: `${NOTE_LEAD}, except rain at exactly 1.00 and snow at exactly 3.0 in/hr, which stay Severe.`,
    edges: `${TODAY_EXAMPLE} ${TODAY_SEVERE_SENTENCE}`,
  },
  {
    name: "(a) wind's High band is closed at 45 mph",
    lowerNumber: `${D01_LEAD}, except wind at exactly 45 mph, which stays High (D-01).`,
    rules: validRules((rules) => {
      closeUpperEdge(rules, "wind", "high");
    }),
    rule:
      `${RULE_LEAD}, except wind at exactly 45 mph, which stays High, and rain at exactly 1.00 in/hr ` +
      "and snow at exactly 3.0 in/hr, which stay Severe.",
    note:
      `${NOTE_LEAD}, except wind at exactly 45 mph, which stays High, and rain at exactly 1.00 and ` +
      "snow at exactly 3.0 in/hr, which stay Severe.",
    edges: `${TODAY_EXAMPLE} Wind at exactly 45 mph stays High. ${TODAY_SEVERE_SENTENCE}`,
  },
  {
    name: "(b) rain's Severe band is closed at 1.5 and snow's at 4",
    lowerNumber: TODAY_D01,
    rules: validRules((rules) => {
      moveUpperEdge(rules, "rain", "severe", 1.5);
      moveUpperEdge(rules, "snow", "severe", 4);
    }),
    rule: `${RULE_LEAD}, except rain at exactly 1.50 in/hr and snow at exactly 4.0 in/hr, which stay Severe.`,
    note: `${NOTE_LEAD}, except rain at exactly 1.50 and snow at exactly 4.0 in/hr, which stay Severe.`,
    edges:
      `${TODAY_EXAMPLE} Rain at exactly 1.50 in/hr and snow at exactly 4.0 in/hr stay Severe, ` +
      "because the brief calls No Travel anything over those values.",
  },
  {
    name: "(c) wind's Low band ends at 30 mph",
    lowerNumber: TODAY_D01,
    rules: validRules((rules) => {
      moveUpperEdge(rules, "wind", "low", 30);
    }),
    rule: `${RULE_LEAD}, except rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr, which stay Severe.`,
    note: `${NOTE_LEAD}, except rain at exactly 1.00 and snow at exactly 3.0 in/hr, which stay Severe.`,
    edges: `${EDGES_LEAD}30.0 mph is Moderate and 29.9 mph is Low. ${TODAY_SEVERE_SENTENCE}`,
  },
  {
    name: "(c) wind is rounded to whole mph",
    lowerNumber: TODAY_D01,
    rules: validRules((rules) => {
      rules.factors.wind.precision = 1;
    }),
    rule: `${RULE_LEAD}, except rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr, which stay Severe.`,
    note: `${NOTE_LEAD}, except rain at exactly 1.00 and snow at exactly 3.0 in/hr, which stay Severe.`,
    edges: `${EDGES_LEAD}25 mph is Moderate and 24 mph is Low. ${TODAY_SEVERE_SENTENCE}`,
  },
  {
    name: "(c) wind is rounded to a hundredth of a mph",
    lowerNumber: TODAY_D01,
    rules: validRules((rules) => {
      rules.factors.wind.precision = 0.01;
    }),
    rule: `${RULE_LEAD}, except rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr, which stay Severe.`,
    note: `${NOTE_LEAD}, except rain at exactly 1.00 and snow at exactly 3.0 in/hr, which stay Severe.`,
    edges: `${EDGES_LEAD}25.00 mph is Moderate and 24.99 mph is Low. ${TODAY_SEVERE_SENTENCE}`,
  },
  {
    name: "(d) no band is closed",
    lowerNumber: TODAY_D01,
    rules: validRules((rules) => {
      openUpperEdge(rules, "rain", "severe");
      openUpperEdge(rules, "snow", "severe");
    }),
    rule: `${RULE_LEAD}.`,
    note: `${NOTE_LEAD}.`,
    edges: TODAY_EXAMPLE,
  },
  {
    name: "(e) the levels have other names",
    lowerNumber: TODAY_D01,
    rules: validRules((rules) => {
      relabel(rules, "low", "Calm");
      relabel(rules, "moderate", "Watch");
      relabel(rules, "severe", "Extreme");
      relabel(rules, "no_travel", "Closed");
    }),
    rule: `${RULE_LEAD}, except rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr, which stay Extreme.`,
    note: `${NOTE_LEAD}, except rain at exactly 1.00 and snow at exactly 3.0 in/hr, which stay Extreme.`,
    edges:
      `${EDGES_LEAD}25.0 mph is Watch and 24.9 mph is Calm. Rain at exactly 1.00 in/hr and snow at ` +
      "exactly 3.0 in/hr stay Extreme, because the brief calls Closed anything over those values.",
  },
  {
    name: "(f) wind's Low band is closed at 25 mph too",
    lowerNumber: `${D01_LEAD}, except wind at exactly 25 mph, which stays Low (D-01).`,
    rules: validRules((rules) => {
      closeUpperEdge(rules, "wind", "low");
    }),
    rule:
      `${RULE_LEAD}, except wind at exactly 25 mph, which stays Low, and rain at exactly 1.00 in/hr ` +
      "and snow at exactly 3.0 in/hr, which stay Severe.",
    note:
      `${NOTE_LEAD}, except wind at exactly 25 mph, which stays Low, and rain at exactly 1.00 and ` +
      "snow at exactly 3.0 in/hr, which stay Severe.",
    edges:
      `${EDGES_LEAD}35.0 mph is High and 34.9 mph is Moderate. Wind at exactly 25 mph stays Low. ` +
      TODAY_SEVERE_SENTENCE,
  },
  {
    name: "(g) wind's Severe band is closed too: three units in one band",
    lowerNumber: `${D01_LEAD}, except wind at exactly 55 mph, which stays Severe (D-01).`,
    rules: validRules((rules) => {
      closeUpperEdge(rules, "wind", "severe");
    }),
    rule:
      `${RULE_LEAD}, except wind at exactly 55 mph, rain at exactly 1.00 in/hr, and snow at ` +
      "exactly 3.0 in/hr, which stay Severe.",
    note:
      `${NOTE_LEAD}, except wind at exactly 55 mph, rain at exactly 1.00 in/hr, and snow at ` +
      "exactly 3.0 in/hr, which stay Severe.",
    edges:
      `${TODAY_EXAMPLE} Wind at exactly 55 mph, rain at exactly 1.00 in/hr, and snow at exactly ` +
      "3.0 in/hr stay Severe.",
  },
  {
    name: "(h) the brief does not write the band above rain's Severe as an open range",
    lowerNumber: `${D01_LEAD}, except rain at exactly 1.00 in/hr, which stays Severe (D-01).`,
    rules: validRules((rules) => {
      rules.factors.rain.brief_labels[4] = "1.00 in/hr or more";
    }),
    rule: `${RULE_LEAD}, except rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr, which stay Severe.`,
    note: `${NOTE_LEAD}, except rain at exactly 1.00 and snow at exactly 3.0 in/hr, which stay Severe.`,
    edges: `${TODAY_EXAMPLE} Rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr stay Severe.`,
  },
];

/** A rules file in which every band but the top one is closed at its upper edge. */
export function closedEverywhere(): RiskRules {
  return validRules((rules) => {
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
}
