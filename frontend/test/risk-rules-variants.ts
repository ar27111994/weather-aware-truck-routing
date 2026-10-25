/**
 * Variants of the bundled risk rules for tests: today's rules with an edit applied, accepted only
 * if both halves of the engine would accept them.
 *
 * - The rules schema (`shared/risk-rules.schema.json`, read here by a small interpreter of the
 *   keywords it uses): which edges each of the five bands of a factor may carry, thresholds above
 *   zero, a precision that is one of its steps.
 * - The invariants the backend loader adds on top of the schema (`haulcast/domain/rules.py`):
 *   bands that meet at one threshold with exactly one of them including it, thresholds that rise,
 *   and thresholds on the precision grid.
 *
 * A test that builds its rules here cannot pass on a rules file the engine would reject.
 */
import schemaJson from "../../shared/risk-rules.schema.json";
import type { RiskBand, RiskFactor, RiskLevel, RiskRules } from "../app/api/contract";
import { RISK_FACTORS } from "../app/api/vocabulary";
import { RISK_RULES } from "../app/lib/risk";

export type JsonRecord = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordAt(node: unknown, key: string): JsonRecord {
  const child = isRecord(node) ? node[key] : undefined;
  if (!isRecord(child)) throw new Error(`The rules schema has no object at "${key}".`);
  return child;
}

export function stringsAt(node: JsonRecord, key: string): string[] {
  const list = node[key];
  if (!Array.isArray(list) || !list.every((item): item is string => typeof item === "string")) {
    throw new Error(`The rules schema has no list of names at "${key}".`);
  }
  return list;
}

function numbersAt(node: JsonRecord, key: string): number[] {
  const list = node[key];
  if (!Array.isArray(list) || !list.every((item): item is number => typeof item === "number")) {
    throw new Error(`The rules schema has no list of numbers at "${key}".`);
  }
  return list;
}

export const SCHEMA_DEFS = recordAt(schemaJson, "$defs");

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
export function allows(node: unknown, keys: ReadonlySet<string>): boolean {
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

export function subsets<Item>(items: readonly Item[]): Item[][] {
  return items.reduce<Item[][]>(
    (all, item) => [...all, ...all.map((part) => [...part, item])],
    [[]],
  );
}

/** The edges a band may have, as the schema names them. */
export const SCHEMA_EDGES = Object.keys(recordAt(recordAt(SCHEMA_DEFS, "band"), "properties"))
  .filter((key) => key !== "level")
  .sort();

/** The schema node of each of the five band positions of a factor, lowest band first. */
function bandPositions(): unknown[] {
  const bands = recordAt(recordAt(recordAt(SCHEMA_DEFS, "factor"), "properties"), "bands")[
    "prefixItems"
  ];
  if (!Array.isArray(bands)) throw new Error("The rules schema lists no band positions.");
  return bands.map((band) => {
    const ref = isRecord(band) ? band["$ref"] : undefined;
    if (typeof ref !== "string")
      throw new Error("A band position of the rules schema has no $ref.");
    return resolveRef(ref);
  });
}

/** Every set of edges that one of the five bands of a factor may carry, as the schema allows it. */
export function bandShapesAllowedBySchema(): string[] {
  const positions = bandPositions();
  return subsets(SCHEMA_EDGES)
    .filter((edges) => positions.some((position) => allows(position, new Set(["level", ...edges]))))
    .map((edges) => edges.join(" + "))
    .sort();
}

// ---- The variants ---------------------------------------------------------------------------

const LEVELS = stringsAt(recordAt(SCHEMA_DEFS, "levelId"), "enum");
const STEPS = numbersAt(recordAt(SCHEMA_DEFS, "step"), "enum");

interface Edge {
  readonly value: number;
  readonly inclusive: boolean;
}

function lowerEdge(band: RiskBand): Edge | undefined {
  if (band.min_inclusive !== undefined) return { value: band.min_inclusive, inclusive: true };
  if (band.min_exclusive !== undefined) return { value: band.min_exclusive, inclusive: false };
  return undefined;
}

function upperEdge(band: RiskBand): Edge | undefined {
  if (band.max_inclusive !== undefined) return { value: band.max_inclusive, inclusive: true };
  if (band.max_exclusive !== undefined) return { value: band.max_exclusive, inclusive: false };
  return undefined;
}

/** What the schema or the backend loader would refuse in these rules, one line each. */
export function problemsIn(rules: RiskRules): string[] {
  const problems: string[] = [];
  const positions = bandPositions();
  for (const factor of RISK_FACTORS) {
    const { precision, bands } = rules.factors[factor];
    const scale = Math.round(1 / precision);
    const say = (what: string): number => problems.push(`${factor}: ${what}`);
    if (!STEPS.includes(precision)) say(`precision ${String(precision)} is not one of its steps`);
    if (bands.length !== positions.length) say(`${String(bands.length)} bands, not five`);
    bands.forEach((band, position) => {
      const edges = SCHEMA_EDGES.filter((edge) => Reflect.get(band, edge) !== undefined);
      if (band.level !== LEVELS[position])
        say(`the band at position ${String(position)} is ${band.level}`);
      if (!allows(positions[position], new Set(["level", ...edges]))) {
        say(`the ${band.level} band may not carry ${edges.join(" + ")}`);
      }
      for (const edge of [lowerEdge(band), upperEdge(band)]) {
        if (edge === undefined) continue;
        if (edge.value <= 0) say(`the ${band.level} band has an edge at ${String(edge.value)}`);
        if (Math.abs(edge.value * scale - Math.round(edge.value * scale)) > 1e-6) {
          say(
            `the ${band.level} edge ${String(edge.value)} is not a multiple of ${String(precision)}`,
          );
        }
      }
      const [low, high] = [lowerEdge(band), upperEdge(band)];
      if (low !== undefined && high !== undefined && low.value >= high.value) {
        say(
          `the ${band.level} band does not rise from ${String(low.value)} to ${String(high.value)}`,
        );
      }
    });
    bands.slice(1).forEach((above, index) => {
      const below = bands[index];
      const top = below === undefined ? undefined : upperEdge(below);
      const bottom = lowerEdge(above);
      if (
        top === undefined ||
        bottom === undefined ||
        Math.round(top.value * scale) !== Math.round(bottom.value * scale) ||
        top.inclusive === bottom.inclusive
      ) {
        say(
          `${above.level} does not meet the band below at one threshold, one of them including it`,
        );
      }
    });
  }
  return problems;
}

/**
 * Today's rules with `edit` applied.
 *
 * @throws {Error} If the schema or the backend loader would refuse the result: a test never runs on
 *   rules the engine rejects.
 */
export function validRules(edit: (rules: RiskRules) => void): RiskRules {
  const rules = structuredClone(RISK_RULES);
  edit(rules);
  const problems = problemsIn(rules);
  if (problems.length > 0) {
    throw new Error(`The engine would reject these rules:\n${problems.join("\n")}`);
  }
  return rules;
}

function bandsAround(
  rules: RiskRules,
  factor: RiskFactor,
  level: RiskLevel,
): readonly [RiskBand, RiskBand] {
  const { bands } = rules.factors[factor];
  const index = bands.findIndex((band) => band.level === level);
  const below = bands[index];
  const above = bands[index + 1];
  if (below === undefined || above === undefined) {
    throw new Error(`${factor} has no ${level} band with a band above it`);
  }
  return [below, above];
}

/**
 * A value exactly on the upper edge of `level` stays in `level` (a closed band, `max_inclusive`);
 * the band above it starts over that value (`min_exclusive`).
 */
export function closeUpperEdge(rules: RiskRules, factor: RiskFactor, level: RiskLevel): void {
  const [below, above] = bandsAround(rules, factor, level);
  const value = below.max_exclusive;
  if (value === undefined) throw new Error(`${factor} ${level} has no open upper edge to close`);
  delete below.max_exclusive;
  below.max_inclusive = value;
  delete above.min_inclusive;
  above.min_exclusive = value;
}

/** The default: a value exactly on the upper edge of `level` belongs to the band above it. */
export function openUpperEdge(rules: RiskRules, factor: RiskFactor, level: RiskLevel): void {
  const [below, above] = bandsAround(rules, factor, level);
  const value = below.max_inclusive;
  if (value === undefined) throw new Error(`${factor} ${level} has no closed upper edge to open`);
  delete below.max_inclusive;
  below.max_exclusive = value;
  delete above.min_exclusive;
  above.min_inclusive = value;
}

/** Moves the edge between `level` and the band above it to `value`; who includes it is kept. */
export function moveUpperEdge(
  rules: RiskRules,
  factor: RiskFactor,
  level: RiskLevel,
  value: number,
): void {
  const [below, above] = bandsAround(rules, factor, level);
  if (below.max_inclusive === undefined) below.max_exclusive = value;
  else below.max_inclusive = value;
  if (above.min_exclusive === undefined) above.min_inclusive = value;
  else above.min_exclusive = value;
}

/** Gives a level another name, as the rules file may. */
export function relabel(rules: RiskRules, level: RiskLevel, label: string): void {
  const entry = rules.levels.find((candidate) => candidate.id === level);
  if (entry === undefined) throw new Error(`The rules list no ${level} level`);
  entry.label = label;
}
