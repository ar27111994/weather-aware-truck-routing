import { describe, expect, it } from "vitest";

import type { LoadRule, RiskBand, RiskRules } from "../../api/contract";
import { RISK_FACTORS } from "../../api/vocabulary";
import { RISK_RULES, classifyFactor } from "../../lib/risk";
import {
  SCHEMA_DEFS,
  SCHEMA_EDGES,
  bandShapesAllowedBySchema,
  closeUpperEdge,
  isRecord,
  moveUpperEdge,
  openUpperEdge,
  problemsIn,
  recordAt,
  relabel,
  stringsAt,
  subsets,
  validRules,
} from "../../../test/risk-rules-variants";
import { llmsFullTxt } from "../seo/files";
import { faqPageLd } from "../seo/structured-data";
import {
  bandEdgesText,
  bandText,
  boundaryNote,
  boundaryRule,
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

/** One band of each shape the schema allows, the decimals its edges are printed with, and its words. */
const BAND_WORDS: readonly (readonly [string, RiskBand, number, string])[] = [
  ["the lowest band, under a number", { level: "low", max_exclusive: 25 }, 0, "under 25"],
  ["the lowest band, up to a number", { level: "low", max_inclusive: 25 }, 0, "25 or less"],
  [
    "a middle band, from a number to under another",
    { level: "moderate", min_inclusive: 25, max_exclusive: 35 },
    0,
    "25 to under 35",
  ],
  [
    "a middle band, from a number to another",
    { level: "severe", min_inclusive: 0.5, max_inclusive: 1 },
    2,
    "0.50 to 1.00",
  ],
  [
    "a middle band, over a number to under another",
    { level: "high", min_exclusive: 1, max_exclusive: 2 },
    2,
    "over 1.00 to under 2.00",
  ],
  [
    "a middle band, over a number through another",
    { level: "high", min_exclusive: 1, max_inclusive: 2 },
    2,
    "over 1.00 through 2.00",
  ],
  ["the top band, from a number", { level: "no_travel", min_inclusive: 55 }, 0, "55 or more"],
  ["the top band, over a number", { level: "no_travel", min_exclusive: 1 }, 2, "over 1.00"],
];

const shapeOf = (band: RiskBand): string =>
  SCHEMA_EDGES.filter((edge) => Reflect.get(band, edge) !== undefined).join(" + ");

describe("bandText", () => {
  it.each(BAND_WORDS)("writes %s in words", (_name, band, decimals, text) => {
    expect(bandText(band, decimals)).toBe(text);
  });

  it("refuses a band with no edge, which the rules schema does not allow", () => {
    expect(() => bandText({ level: "low" }, 0)).toThrow("A risk band needs at least one edge.");
  });

  it("has words for every shape of band the rules schema allows, and for no other", () => {
    expect(SCHEMA_EDGES).toEqual([
      "max_exclusive",
      "max_inclusive",
      "min_exclusive",
      "min_inclusive",
    ]);
    expect(BAND_WORDS.map(([, band]) => shapeOf(band)).sort()).toEqual(bandShapesAllowedBySchema());
  });

  it("states every edge of every shape the schema allows, and writes no two shapes alike", () => {
    const written = bandShapesAllowedBySchema().map((shape) => {
      const edges = shape.split(" + ");
      const band: RiskBand = {
        level: "moderate",
        ...(edges.includes("min_inclusive") ? { min_inclusive: 1 } : {}),
        ...(edges.includes("min_exclusive") ? { min_exclusive: 2 } : {}),
        ...(edges.includes("max_inclusive") ? { max_inclusive: 3 } : {}),
        ...(edges.includes("max_exclusive") ? { max_exclusive: 4 } : {}),
      };
      const numbers = Object.values(band).filter(
        (value): value is number => typeof value === "number",
      );
      return { shape, text: bandText(band, 2), numbers };
    });

    for (const { shape, text, numbers } of written) {
      for (const number of numbers) {
        expect(text, `the words for ${shape} leave out the edge ${String(number)}`).toContain(
          number.toFixed(2),
        );
      }
    }
    expect(new Set(written.map(({ text }) => text)).size).toBe(written.length);
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
const TODAY_SEVERE_SENTENCE =
  "Rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr stay Severe, because the brief calls " +
  "No Travel anything over those values.";

interface BoundaryCase {
  readonly name: string;
  readonly rules: RiskRules;
  /** The boundary rule of the methodology page. */
  readonly rule: string;
  /** The footnote of the map legend. */
  readonly note: string;
  /** The "where one band ends and the next begins" choice. */
  readonly edges: string;
}

const BOUNDARY_CASES: readonly BoundaryCase[] = [
  {
    name: "today's rules",
    rules: validRules(() => undefined),
    rule: `${RULE_LEAD}, except rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr, which stay Severe.`,
    note: `${NOTE_LEAD}, except rain at exactly 1.00 and snow at exactly 3.0 in/hr, which stay Severe.`,
    edges: `${TODAY_EXAMPLE} ${TODAY_SEVERE_SENTENCE}`,
  },
  {
    name: "(a) wind's High band is closed at 45 mph",
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
    rules: validRules((rules) => {
      moveUpperEdge(rules, "wind", "low", 30);
    }),
    rule: `${RULE_LEAD}, except rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr, which stay Severe.`,
    note: `${NOTE_LEAD}, except rain at exactly 1.00 and snow at exactly 3.0 in/hr, which stay Severe.`,
    edges: `${EDGES_LEAD}30.0 mph is Moderate and 29.9 mph is Low. ${TODAY_SEVERE_SENTENCE}`,
  },
  {
    name: "(c) wind is rounded to whole mph",
    rules: validRules((rules) => {
      rules.factors.wind.precision = 1;
    }),
    rule: `${RULE_LEAD}, except rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr, which stay Severe.`,
    note: `${NOTE_LEAD}, except rain at exactly 1.00 and snow at exactly 3.0 in/hr, which stay Severe.`,
    edges: `${EDGES_LEAD}25 mph is Moderate and 24 mph is Low. ${TODAY_SEVERE_SENTENCE}`,
  },
  {
    name: "(c) wind is rounded to a hundredth of a mph",
    rules: validRules((rules) => {
      rules.factors.wind.precision = 0.01;
    }),
    rule: `${RULE_LEAD}, except rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr, which stay Severe.`,
    note: `${NOTE_LEAD}, except rain at exactly 1.00 and snow at exactly 3.0 in/hr, which stay Severe.`,
    edges: `${EDGES_LEAD}25.00 mph is Moderate and 24.99 mph is Low. ${TODAY_SEVERE_SENTENCE}`,
  },
  {
    name: "(d) no band is closed",
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
    rules: validRules((rules) => {
      rules.factors.rain.brief_labels[4] = "1.00 in/hr or more";
    }),
    rule: `${RULE_LEAD}, except rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr, which stay Severe.`,
    note: `${NOTE_LEAD}, except rain at exactly 1.00 and snow at exactly 3.0 in/hr, which stay Severe.`,
    edges: `${TODAY_EXAMPLE} Rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr stay Severe.`,
  },
];

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
    expect(boundaryRule(everyEdgeClosed)).toContain("which stay Low");
    expect(boundaryRule(everyEdgeClosed)).toContain("which stay Severe.");
  });
});

describe("the example of the band edges (RT-F2)", () => {
  it("is looked for in the next factor when wind has no edge that a band includes", () => {
    const windClosed = validRules((rules) => {
      for (const level of ["low", "moderate", "high", "severe"] as const) {
        closeUpperEdge(rules, "wind", level);
      }
    });

    expect(bandEdgesText(windClosed)).toMatch(
      /^Each band includes its lower number, so 0\.100 in\/hr is Moderate and 0\.099 in\/hr is Low\. /u,
    );
  });
});

describe("the rules variants of the tests (RT-F2)", () => {
  it("accept today's rules and every case above", () => {
    expect(problemsIn(RISK_RULES)).toEqual([]);
    for (const { rules } of BOUNDARY_CASES) expect(problemsIn(rules)).toEqual([]);
  });

  it.each<[string, (rules: RiskRules) => void, string]>([
    [
      "two bands that leave a gap",
      (rules) => {
        rules.factors.wind.bands[0] = { level: "low", max_exclusive: 20 };
      },
      "moderate does not meet the band below at one threshold",
    ],
    [
      "two bands that both include their shared edge",
      (rules) => {
        const [low] = rules.factors.wind.bands;
        if (low === undefined) throw new Error("wind has no bands");
        delete low.max_exclusive;
        low.max_inclusive = 25;
      },
      "moderate does not meet the band below at one threshold",
    ],
    [
      "a lowest band with a lower edge",
      (rules) => {
        const [low] = rules.factors.wind.bands;
        if (low === undefined) throw new Error("wind has no bands");
        low.min_inclusive = 5;
      },
      "the low band may not carry max_exclusive + min_inclusive",
    ],
    [
      "a precision that is not a step",
      (rules) => {
        rules.factors.rain.precision = 0.5;
      },
      "precision 0.5 is not one of its steps",
    ],
    [
      "an edge off the precision grid",
      (rules) => {
        rules.factors.wind.precision = 1;
        moveUpperEdge(rules, "wind", "low", 25.5);
      },
      "is not a multiple of 1",
    ],
  ])("refuse %s", (_name, edit, problem) => {
    expect(() => validRules(edit)).toThrow(problem);
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

  describe("every shape the rules schema allows (R4-13)", () => {
    const rule = (upper: number | undefined, load: number | null): LoadRule => ({
      id: "LR-9",
      factor: "wind",
      min_inclusive: 45,
      ...(upper === undefined ? {} : { max_exclusive: upper }),
      load_lb_min_exclusive: load,
      result: "severe",
      brief_text: "unused",
    });
    const sentenceOf = (one: LoadRule): string | undefined =>
      loadRuleSentences(
        changed((copy) => {
          copy.load_rules = [one];
        }),
      )[0];

    it.each<[string, number | undefined, number | null, string]>([
      [
        "wind with no upper edge, for any load",
        undefined,
        null,
        "LR-9: wind of 45 mph or more is Severe for any load.",
      ],
      [
        "wind with an upper edge, for any load",
        55,
        null,
        "LR-9: wind from 45 to under 55 mph is Severe for any load.",
      ],
      [
        "wind with no upper edge, above a weight",
        undefined,
        30_000,
        "LR-9: wind of 45 mph or more with a load over 30,000 lb is Severe.",
      ],
      [
        "wind with an upper edge, above a weight",
        55,
        30_000,
        "LR-9: wind from 45 to under 55 mph with a load over 30,000 lb is Severe.",
      ],
    ])("writes a rule on %s", (_name, upper, load, sentence) => {
      expect(sentenceOf(rule(upper, load))).toBe(sentence);
    });

    it("states every condition of every shape of rule the schema allows, and writes no two alike", () => {
      const schema = recordAt(SCHEMA_DEFS, "loadRule");
      const properties = recordAt(schema, "properties");
      const required = stringsAt(schema, "required");
      const optional = Object.keys(properties).filter((key) => !required.includes(key));
      const nullable = required.filter((key) => {
        const type = recordAt(properties, key)["type"];
        return Array.isArray(type) && type.includes("null");
      });

      // A property the schema gains is one more condition for the sentence to state.
      expect(Object.keys(properties).sort()).toEqual([
        "brief_text",
        "factor",
        "id",
        "load_lb_min_exclusive",
        "max_exclusive",
        "min_inclusive",
        "result",
      ]);
      expect(optional).toEqual(["max_exclusive"]);
      expect(nullable).toEqual(["load_lb_min_exclusive"]);

      const sentences = subsets(optional).flatMap((present) =>
        [null, 30_000].map((load) => {
          const upper = present.includes("max_exclusive") ? 55 : undefined;
          return { upper, load, text: sentenceOf(rule(upper, load)) ?? "" };
        }),
      );
      expect(sentences).toHaveLength(4);
      for (const { upper, load, text } of sentences) {
        const shape = `${upper === undefined ? "open" : "bounded"} wind, ${load === null ? "any load" : "weighted"}`;
        expect(text, shape).toContain("45");
        if (upper !== undefined) expect(text, `${shape}: the upper wind edge`).toContain("55");
        if (load === null) expect(text, shape).toContain("any load");
        else expect(text, `${shape}: the weight`).toContain("30,000");
      }
      expect(new Set(sentences.map(({ text }) => text)).size).toBe(sentences.length);
    });
  });
});

describe("the texts that are built from the rules (R4-13)", () => {
  /**
   * A schema-valid edit: the bands of snow written with every kind of edge, and two load rules of
   * the shapes the rules file does not use yet.
   */
  const edited = changed((copy) => {
    const snow = copy.factors.snow.bands;
    const set = (level: RiskBand["level"], band: RiskBand): void => {
      const at = snow.findIndex((candidate) => candidate.level === level);
      if (at < 0) throw new Error(`snow has no ${level} band`);
      snow[at] = band;
    };
    set("moderate", { level: "moderate", min_inclusive: 0.5, max_inclusive: 1 });
    set("high", { level: "high", min_exclusive: 1, max_inclusive: 2 });
    set("severe", { level: "severe", min_exclusive: 2, max_exclusive: 3 });
    set("no_travel", { level: "no_travel", min_inclusive: 3 });
    copy.load_rules.push(
      {
        id: "LR-4",
        factor: "wind",
        min_inclusive: 25,
        max_exclusive: 35,
        load_lb_min_exclusive: null,
        result: "moderate",
        brief_text: "unused",
      },
      {
        id: "LR-5",
        factor: "wind",
        min_inclusive: 55,
        load_lb_min_exclusive: 20_000,
        result: "no_travel",
        brief_text: "unused",
      },
    );
  });

  it("llms-full.txt states every edge of every band and every condition of every load rule", () => {
    const full = llmsFullTxt("https://haulcast.example", edited);

    expect(full).toContain(
      "| Snow (in/hr) | under 0.5 | 0.5 to 1.0 | over 1.0 through 2.0 | over 2.0 to under 3.0 | 3.0 or more |",
    );
    expect(full).toContain("LR-4: wind from 25 to under 35 mph is Moderate for any load.");
    expect(full).toContain("LR-5: wind of 55 mph or more with a load over 20,000 lb is No Travel.");
  });

  it("llms-full.txt carries the boundary sentences of the rules it is given (RT-F2)", () => {
    for (const { name, rules, rule, edges } of BOUNDARY_CASES) {
      const full = llmsFullTxt("https://haulcast.example", rules);

      expect(full, name).toContain(rule);
      expect(full, name).toContain(edges);
    }
  });

  it("the FAQ structured data states the weight a rule with no upper wind edge depends on", () => {
    const entities = faqPageLd(edited)["mainEntity"];
    const answers = (Array.isArray(entities) ? entities : []).flatMap((question: unknown) => {
      const answer = isRecord(question) ? question["acceptedAnswer"] : undefined;
      return isRecord(answer) ? [String(answer["text"])] : [];
    });

    expect(answers.join("\n")).toContain(
      "LR-5: wind of 55 mph or more with a load over 20,000 lb is No Travel.",
    );
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
