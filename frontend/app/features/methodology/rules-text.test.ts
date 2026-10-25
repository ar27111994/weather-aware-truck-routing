import { describe, expect, it } from "vitest";

import schemaJson from "../../../../shared/risk-rules.schema.json";
import type { LoadRule, RiskBand, RiskRules } from "../../api/contract";
import { RISK_FACTORS } from "../../api/vocabulary";
import { bandText } from "../../lib/boundary-text";
import { at } from "../../lib/checked";
import { RISK_RULES } from "../../lib/risk";
import { BOUNDARY_CASES, closedEverywhere } from "../../../test/boundary-cases";
import {
  SCHEMA_DEFS,
  SCHEMA_EDGES,
  bandShapesAllowedBySchema,
  isRecord,
  moveUpperEdge,
  problemsIn,
  recordAt,
  relabel,
  stringsAt,
  subsets,
  validRules,
  type JsonRecord,
} from "../../../test/risk-rules-variants";
import { llmsFullTxt } from "../seo/files";
import { faqPageLd } from "../seo/structured-data";
import {
  factorRule,
  faqAnswer,
  levelNames,
  loadIntro,
  loadLimits,
  loadRange,
  loadRuleSentences,
  lowerNumberRule,
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

// ---- The last rule facts in fixed text (RT-F4) ------------------------------------------------
//
// Four more strings stated a fact about the rules in words the rules file can make false: the D-01
// assumption, the paragraph on how the factors combine, the FAQ answer about the levels and the
// legend's band words (those are tested with bandWords, in lib/boundary-text.test.ts). Each fact
// either comes from the rules (a case below is a rules file the engine accepts that the old words
// would state wrongly) or the rules schema pins it (the last block reads the schema).

const TODAY_LEVELS_ANSWER =
  "Low, Moderate, High, Severe and No Travel come from wind, rain and snow thresholds. Each factor " +
  "has five ranges, and a checkpoint takes the highest level among them. Missing data is Unknown, " +
  "never Low.";

describe("assumption D-01 (RT-F4)", () => {
  it.each(BOUNDARY_CASES)("$name", ({ rules, lowerNumber }) => {
    expect(lowerNumberRule(rules)).toBe(lowerNumber);
  });

  it("names every edge that stays in its band, except those the brief writes as an open range", () => {
    expect(lowerNumberRule(closedEverywhere())).toBe(
      "Each band includes its lower number, except wind at exactly 25 mph, rain at exactly 0.10 in/hr, " +
        "and snow at exactly 0.5 in/hr, which stay Low, wind at exactly 35 mph, rain at exactly 0.25 in/hr, " +
        "and snow at exactly 1.0 in/hr, which stay Moderate, wind at exactly 45 mph, rain at exactly 0.50 in/hr, " +
        "and snow at exactly 2.0 in/hr, which stay High, and wind at exactly 55 mph, which stays Severe (D-01).",
    );
  });
});

describe("the FAQ answer about the levels (RT-F4)", () => {
  it("is today's words for today's rules", () => {
    expect(faqAnswer("levels", RISK_RULES)).toBe(TODAY_LEVELS_ANSWER);
  });

  it("names the levels as the rules file does, and never-Low is its lowest level", () => {
    const rules = validRules((copy) => {
      relabel(copy, "low", "Calm");
      relabel(copy, "moderate", "Watch");
      relabel(copy, "severe", "Extreme");
      relabel(copy, "no_travel", "Closed");
    });

    expect(faqAnswer("levels", rules)).toBe(
      "Calm, Watch, High, Extreme and Closed come from wind, rain and snow thresholds. Each factor " +
        "has five ranges, and a checkpoint takes the highest level among them. Missing data is " +
        "Unknown, never Calm.",
    );
  });

  it("names the factors as the rules file does", () => {
    const rules = validRules((copy) => {
      copy.factors.wind.label = "Gusts";
      copy.factors.snow.label = "Snowfall";
    });

    expect(faqAnswer("levels", rules)).toBe(
      "Low, Moderate, High, Severe and No Travel come from gusts, rain and snowfall thresholds. Each " +
        "factor has five ranges, and a checkpoint takes the highest level among them. Missing data " +
        "is Unknown, never Low.",
    );
  });
});

describe("the paragraph on how the factors combine (RT-F4)", () => {
  it("is today's words for today's rules", () => {
    expect(factorRule(RISK_RULES)).toBe(
      "A checkpoint takes the highest level among wind, rain and snow. A factor with no forecast is " +
        "left out and the checkpoint is marked incomplete. When all three are missing, the " +
        "checkpoint is Unknown.",
    );
  });

  it("names the factors as the rules file does", () => {
    const rules = validRules((copy) => {
      copy.factors.wind.label = "Gusts";
      copy.factors.snow.label = "Snowfall";
    });

    expect(factorRule(rules)).toBe(
      "A checkpoint takes the highest level among gusts, rain and snowfall. A factor with no " +
        "forecast is left out and the checkpoint is marked incomplete. When all three are missing, " +
        "the checkpoint is Unknown.",
    );
  });
});

describe("levelNames (RT-F4)", () => {
  it("is the labels of the rules file, lowest level first", () => {
    expect(levelNames(RISK_RULES)).toEqual(["Low", "Moderate", "High", "Severe", "No Travel"]);
    expect(
      levelNames(
        validRules((copy) => {
          relabel(copy, "no_travel", "Closed");
        }),
      ),
    ).toEqual(["Low", "Moderate", "High", "Severe", "Closed"]);
  });
});

describe("what the rules schema pins, and the words that rely on it (RT-F4)", () => {
  const WORDS = ["zero", "one", "two", "three", "four", "five", "six"] as const;
  const properties = recordAt(schemaJson, "properties");
  const levels = recordAt(properties, "levels");
  const factors = recordAt(properties, "factors");
  const factor = recordAt(recordAt(SCHEMA_DEFS, "factor"), "properties");

  /** How many items a schema for an array allows: `items: false` closes the list after `prefixItems`. */
  function itemsAllowed(schema: JsonRecord): readonly [number, number] {
    const prefix = schema["prefixItems"];
    const min = typeof schema["minItems"] === "number" ? schema["minItems"] : 0;
    const max = schema["maxItems"];
    if (typeof max === "number") return [min, max];
    return [min, schema["items"] === false && Array.isArray(prefix) ? prefix.length : Infinity];
  }

  function positions(schema: JsonRecord, key: string, name: string): unknown[] {
    const list = schema["prefixItems"];
    if (!Array.isArray(list)) throw new Error("The rules schema lists no positions.");
    return list.map((item: unknown) => recordAt(recordAt(item, "properties"), key)[name]);
  }

  it("allows exactly five bands for each factor, so the FAQ can say each factor has five ranges", () => {
    const [min, max] = itemsAllowed(recordAt(factor, "bands"));

    expect([min, max]).toEqual([5, 5]);
    expect(faqAnswer("levels", RISK_RULES)).toContain(`Each factor has ${at(WORDS, max)} ranges`);
  });

  it("allows exactly five wordings of the brief for each factor, one for each band", () => {
    expect(itemsAllowed(recordAt(factor, "brief_labels"))).toEqual([5, 5]);
  });

  it("allows exactly the factors wind, rain and snow, so the paragraph can say all three are missing", () => {
    expect(factors["additionalProperties"]).toBe(false);
    expect(stringsAt(factors, "required")).toEqual([...RISK_FACTORS]);
    expect(Object.keys(recordAt(factors, "properties"))).toEqual([...RISK_FACTORS]);
    expect(factorRule(RISK_RULES)).toContain(`When all ${WORDS[RISK_FACTORS.length]} are missing`);
  });

  it("lists the five levels lowest first, each band of a factor at the position of its level", () => {
    const ids = ["low", "moderate", "high", "severe", "no_travel"];

    expect(itemsAllowed(levels)).toEqual([5, 5]);
    expect(positions(levels, "id", "const")).toEqual(ids);
    expect(positions(levels, "ordinal", "const")).toEqual([0, 1, 2, 3, 4]);
    expect(positions(recordAt(factor, "bands"), "level", "const")).toEqual(ids);
    expect(RISK_RULES.levels.map((level) => level.id)).toEqual(ids);
  });
});
