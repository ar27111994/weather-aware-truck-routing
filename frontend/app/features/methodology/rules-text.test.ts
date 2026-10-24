import { describe, expect, it } from "vitest";

import type { LoadRule, RiskBand, RiskRules } from "../../api/contract";
import { RISK_RULES } from "../../lib/risk";
import schemaJson from "../../../../shared/risk-rules.schema.json";
import { llmsFullTxt } from "../seo/files";
import { faqPageLd } from "../seo/structured-data";
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

// ---- What the rules schema allows (R4-13) --------------------------------------------------------
//
// The page, llms-full.txt and the FAQ JSON-LD say what the engine does. The engine reads whatever
// `shared/risk-rules.schema.json` accepts, so the words have to cover all of it. These helpers read
// the shapes off the schema itself: a shape the schema gains and the words lack fails a test, and
// a schema keyword this reader does not know fails it too, rather than being skipped.

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(node: unknown, key: string): JsonRecord {
  const child = isRecord(node) ? node[key] : undefined;
  if (!isRecord(child)) throw new Error(`The rules schema has no object at "${key}".`);
  return child;
}

function stringsAt(node: JsonRecord, key: string): string[] {
  const list = node[key];
  if (!Array.isArray(list) || !list.every((item): item is string => typeof item === "string")) {
    throw new Error(`The rules schema has no list of names at "${key}".`);
  }
  return list;
}

const SCHEMA_DEFS = recordAt(schemaJson, "$defs");

/** Keywords that decide which keys an object may carry: `allows` reads each of them. */
const READ_KEYWORDS = new Set([
  "$ref",
  "allOf",
  "oneOf",
  "anyOf",
  "not",
  "required",
  "properties",
  "additionalProperties",
]);

/** Keywords that say nothing about which keys are present (types, ranges, notes). */
const SILENT_KEYWORDS = new Set([
  "type",
  "const",
  "enum",
  "minimum",
  "exclusiveMinimum",
  "minLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "pattern",
  "items",
  "prefixItems",
  "description",
  "title",
  "$comment",
]);

function resolveRef(ref: string): unknown {
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) throw new Error(`This test cannot follow the reference "${ref}".`);
  return SCHEMA_DEFS[ref.slice(prefix.length)];
}

/** Whether a schema node accepts an object that carries exactly these keys (values are not read). */
function allows(node: unknown, keys: ReadonlySet<string>): boolean {
  if (!isRecord(node)) throw new Error("A node of the rules schema has to be an object.");
  for (const keyword of Object.keys(node)) {
    if (!READ_KEYWORDS.has(keyword) && !SILENT_KEYWORDS.has(keyword)) {
      throw new Error(
        `This test cannot read the schema keyword "${keyword}". Teach it to, and write the words ` +
          "for whatever the keyword allows.",
      );
    }
  }
  const listAt = (keyword: string): unknown[] => {
    const list = node[keyword];
    return Array.isArray(list) ? list : [];
  };
  const ref = node["$ref"];
  if (typeof ref === "string" && !allows(resolveRef(ref), keys)) return false;
  if (!listAt("allOf").every((sub) => allows(sub, keys))) return false;
  const exactlyOne = listAt("oneOf");
  if (exactlyOne.length > 0 && exactlyOne.filter((sub) => allows(sub, keys)).length !== 1) {
    return false;
  }
  const anyOne = listAt("anyOf");
  if (anyOne.length > 0 && !anyOne.some((sub) => allows(sub, keys))) return false;
  if ("not" in node && allows(node["not"], keys)) return false;
  const required = node["required"];
  if (Array.isArray(required) && !required.every((key) => keys.has(String(key)))) return false;
  if (node["additionalProperties"] === false) {
    const named = Object.keys(recordAt(node, "properties"));
    if (![...keys].every((key) => named.includes(key))) return false;
  }
  return true;
}

function subsets<Item>(items: readonly Item[]): Item[][] {
  return items.reduce<Item[][]>(
    (all, item) => [...all, ...all.map((part) => [...part, item])],
    [[]],
  );
}

/** The edges a band may have, as the schema names them. */
const SCHEMA_EDGES = Object.keys(recordAt(recordAt(SCHEMA_DEFS, "band"), "properties"))
  .filter((key) => key !== "level")
  .sort();

/** Every set of edges that one of the five bands of a factor may carry, as the schema allows it. */
function bandShapesAllowedBySchema(): string[] {
  const bands = recordAt(recordAt(recordAt(SCHEMA_DEFS, "factor"), "properties"), "bands")[
    "prefixItems"
  ];
  if (!Array.isArray(bands)) throw new Error("The rules schema lists no band positions.");
  const positions = bands.map((band) => {
    const ref = isRecord(band) ? band["$ref"] : undefined;
    if (typeof ref !== "string")
      throw new Error("A band position of the rules schema has no $ref.");
    return resolveRef(ref);
  });
  return subsets(SCHEMA_EDGES)
    .filter((edges) => positions.some((position) => allows(position, new Set(["level", ...edges]))))
    .map((edges) => edges.join(" + "))
    .sort();
}

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
