import type { LoadRule, RiskBand, RiskFactor, RiskLevel, RiskRules } from "../../api/contract";
import { RISK_FACTORS } from "../../api/vocabulary";
import { t, tPlural, type StringKey } from "../../design-system/foundation/strings";
import { at } from "../../lib/checked";

/** The page is English and its numbers are written one way, so the prerendered text never differs from the browser's. */
const NUMBER = new Intl.NumberFormat("en-US");
const LIST = new Intl.ListFormat("en-US", { style: "long", type: "conjunction" });

/** The ranking keys the rules file may name, each with the words the page uses for it. */
const RANKING_KEY_TEXT = {
  no_travel_mi: "methodology.ranking.keys.no_travel_mi",
  coverage: "methodology.ranking.keys.coverage",
  severe_mi: "methodology.ranking.keys.severe_mi",
  high_mi: "methodology.ranking.keys.high_mi",
  avg_risk: "methodology.ranking.keys.avg_risk",
  duration_s: "methodology.ranking.keys.duration_s",
} as const satisfies Record<string, StringKey>;

type RankingKey = keyof typeof RANKING_KEY_TEXT;

function isRankingKey(key: string): key is RankingKey {
  return Object.hasOwn(RANKING_KEY_TEXT, key);
}

/** A number as the rules file writes it, counted to the decimals it needs. */
function decimalsOf(value: number): number {
  const text = String(value);
  const point = text.indexOf(".");
  return point < 0 ? 0 : text.length - point - 1;
}

function edgesOf(band: RiskBand): number[] {
  return [band.min_inclusive, band.min_exclusive, band.max_inclusive, band.max_exclusive].filter(
    (edge): edge is number => edge !== undefined,
  );
}

/**
 * How many decimals print every edge of a factor the same way: the most any edge needs. Rain's
 * edges are 0.1, 0.25, 0.5 and 1, so all four print with two (0.10, 0.25, 0.50, 1.00).
 */
export function edgeDecimals(bands: readonly RiskBand[]): number {
  return Math.max(0, ...bands.flatMap((band) => edgesOf(band).map(decimalsOf)));
}

/**
 * One band in words, read off its edges: "under 25", "25 or less", "25 to under 35",
 * "0.50 to 1.00", "over 1.00 to under 2.00", "over 1.00 through 2.00", "55 or more", "over 1.00".
 * A band has at most one lower and one upper edge, each inclusive or exclusive (the rules schema),
 * and every combination has its own words: a band written without its upper edge would state a
 * range the engine does not apply.
 *
 * @throws {Error} If the band has no edge at all, which the rules schema does not allow.
 */
export function bandText(band: RiskBand, decimals: number): string {
  const edge = (value: number): string => value.toFixed(decimals);
  const {
    min_inclusive: from,
    min_exclusive: above,
    max_inclusive: through,
    max_exclusive: below,
  } = band;
  if (from !== undefined && below !== undefined) {
    return t("methodology.rules.band.between", { min: edge(from), max: edge(below) });
  }
  if (from !== undefined && through !== undefined) {
    return t("methodology.rules.band.through", { min: edge(from), max: edge(through) });
  }
  if (above !== undefined && below !== undefined) {
    return t("methodology.rules.band.overBetween", { min: edge(above), max: edge(below) });
  }
  if (above !== undefined && through !== undefined) {
    return t("methodology.rules.band.overThrough", { min: edge(above), max: edge(through) });
  }
  if (from !== undefined) return t("methodology.rules.band.atLeast", { min: edge(from) });
  if (above !== undefined) return t("methodology.rules.band.over", { min: edge(above) });
  if (below !== undefined) return t("methodology.rules.band.under", { max: edge(below) });
  if (through !== undefined) return t("methodology.rules.band.atMost", { max: edge(through) });
  throw new Error("A risk band needs at least one edge.");
}

/** One cell of the risk table: a level and the range of the factor that gives it. */
export interface RiskTableCell {
  readonly level: RiskLevel;
  readonly text: string;
}

/** One row of the risk table: a weather factor and its five ranges. */
export interface RiskTableRow {
  readonly factor: RiskFactor;
  /** "Wind (mph)": the factor's name and its unit. */
  readonly name: string;
  readonly cells: readonly RiskTableCell[];
}

/** The rows of the risk table, built from the rules file and from nothing else. */
export function riskTableRows(rules: RiskRules): readonly RiskTableRow[] {
  return RISK_FACTORS.map((factor) => {
    const { label, unit, bands } = rules.factors[factor];
    const decimals = edgeDecimals(bands);
    return {
      factor,
      name: t("methodology.rules.row", { factor: label, unit }),
      cells: bands.map((band) => ({ level: band.level, text: bandText(band, decimals) })),
    };
  });
}

function levelName(rules: RiskRules, level: RiskLevel): string {
  return rules.levels.find((candidate) => candidate.id === level)?.label ?? level;
}

/** A reading and its unit: "25.0 mph". */
function withUnit(text: string, unit: string): string {
  return t("methodology.boundaries.withUnit", { text, unit });
}

/** The text with its first letter in capitals, for a sentence that starts with it. */
function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One value that stays in its band exactly on the band's upper edge. */
interface BoundaryStay {
  /** The factor, in lower case: "rain". */
  readonly factor: string;
  /** The edge, printed the way the risk table prints the edges of the factor. */
  readonly value: string;
  readonly unit: string;
  /** Whether the brief writes the band above as an open range (">1.00"). */
  readonly briefSaysOver: boolean;
}

/** The values that stay in one band exactly on its upper edge, and the band that starts over them. */
interface BoundaryGroup {
  readonly level: string;
  readonly above: string;
  readonly stays: readonly BoundaryStay[];
}

/** A band's values as they are collected, factor by factor. */
interface PendingGroup {
  readonly above: RiskLevel;
  readonly stays: BoundaryStay[];
}

/**
 * The one fact behind every sentence about the edges of the bands: which values stay in their
 * band exactly on its upper edge (`max_inclusive`; the band above starts over it), grouped by
 * band in the order the rules file lists them. A value exactly on any other edge belongs to the
 * band above. The backend loader makes the two sides of an edge agree, so this is the whole list.
 */
function boundaryGroups(rules: RiskRules): readonly BoundaryGroup[] {
  const groups = new Map<RiskLevel, PendingGroup>();
  for (const factor of RISK_FACTORS) {
    const { label, unit, bands, brief_labels: brief } = rules.factors[factor];
    const decimals = edgeDecimals(bands);
    for (const [index, band] of bands.entries()) {
      if (band.max_inclusive === undefined) continue;
      const group: PendingGroup = groups.get(band.level) ?? {
        above: at(bands, index + 1).level,
        stays: [],
      };
      group.stays.push({
        factor: label.toLowerCase(),
        value: band.max_inclusive.toFixed(decimals),
        unit,
        briefSaysOver: at(brief, index + 1).startsWith(">"),
      });
      groups.set(band.level, group);
    }
  }
  return [...groups].map(([level, { above, stays }]) => ({
    level: levelName(rules, level),
    above: levelName(rules, above),
    stays,
  }));
}

/** The values of one band in words, each with its unit: "rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr". */
function staysText(stays: readonly BoundaryStay[]): string {
  return LIST.format(
    stays.map(({ factor, value, unit }) =>
      withUnit(t("methodology.boundaries.exception", { factor, value }), unit),
    ),
  );
}

/** The same, for a small space: values that share a unit say it once, after the last. */
function staysTextShort(stays: readonly BoundaryStay[]): string {
  const { unit } = at(stays, 0);
  if (!stays.every((stay) => stay.unit === unit)) return staysText(stays);
  return withUnit(
    LIST.format(
      stays.map(({ factor, value }) => t("methodology.boundaries.exception", { factor, value })),
    ),
    unit,
  );
}

/**
 * Clauses that carry commas of their own, one after the other, with a comma before the last one
 * even when there are only two, so the reader can tell where one ends: "A, which stays High, and
 * B, which stay Severe".
 */
function joinClauses(clauses: readonly string[]): string {
  const last = at(clauses, clauses.length - 1);
  if (clauses.length === 1) return last;
  return `${clauses.slice(0, -1).join(", ")}, ${t("methodology.boundaries.and")} ${last}`;
}

/** What a sentence adds when some values stay in their band on its edge: nothing when none do. */
function exceptionClause(
  groups: readonly BoundaryGroup[],
  write: (stays: readonly BoundaryStay[]) => string,
): string {
  if (groups.length === 0) return "";
  const clauses = groups.map(({ level, stays }) =>
    t("methodology.boundaries.group", {
      list: write(stays),
      stay: tPlural("methodology.boundaries.stay", stays.length),
      level,
    }),
  );
  return t("methodology.boundaries.except", { groups: joinClauses(clauses) });
}

/** Where a value exactly on the edge of a band goes, as the methodology page says it. */
export function boundaryRule(rules: RiskRules): string {
  return t("methodology.boundaries.rule", {
    exceptions: exceptionClause(boundaryGroups(rules), staysText),
  });
}

/** The same, as the map legend's footnote says it. */
export function boundaryNote(rules: RiskRules): string {
  return t("legend.boundaryNote", {
    exceptions: exceptionClause(boundaryGroups(rules), staysTextShort),
  });
}

/**
 * A value exactly on an edge that a band includes, and the value one display step below it
 * (the precision of the factor, which is what the engine rounds to), with the band each is in:
 * "25.0 mph is Moderate and 24.9 mph is Low". It is taken from the first edge the rules write
 * as `min_inclusive`, so the example never shows a value on an edge that closes a band; `null`
 * when no edge is written that way.
 */
function edgeExample(rules: RiskRules): string | null {
  for (const factor of RISK_FACTORS) {
    const { unit, precision, bands } = rules.factors[factor];
    const decimals = decimalsOf(precision);
    for (const [index, band] of bands.entries()) {
      if (band.min_inclusive === undefined) continue;
      return t("methodology.choices.bandEdges.what", {
        onEdge: withUnit(band.min_inclusive.toFixed(decimals), unit),
        onLevel: levelName(rules, band.level),
        offEdge: withUnit((band.min_inclusive - precision).toFixed(decimals), unit),
        offLevel: levelName(rules, at(bands, index - 1).level),
      });
    }
  }
  return null;
}

/**
 * The "where one band ends and the next begins" choice: the example, then one sentence for each
 * band whose upper edge belongs to it. The reason is the brief's only when the brief writes the
 * band above every one of those values as an open range (its label starts with ">").
 */
export function bandEdgesText(rules: RiskRules): string {
  const example = edgeExample(rules);
  const sentences = boundaryGroups(rules).map(({ level, above, stays }) =>
    t("methodology.choices.bandEdges.stays", {
      list: capitalized(staysText(stays)),
      stay: tPlural("methodology.boundaries.stay", stays.length),
      level,
      because: stays.every((stay) => stay.briefSaysOver)
        ? t("methodology.choices.bandEdges.because", { above })
        : "",
    }),
  );
  return [...(example === null ? [] : [example]), ...sentences].join(" ");
}

/**
 * One load rule as a sentence. Its two conditions are worded on their own: the wind range (closed
 * above by `max_exclusive`, or open) and the weight (any load, or over a limit). A rule that has
 * either one has to say so, or the page would state a rule the engine does not apply.
 */
function loadRuleSentence(rules: RiskRules, rule: LoadRule): string {
  const { unit } = rules.factors[rule.factor];
  const result = levelName(rules, rule.result);
  const { id, min_inclusive: min, max_exclusive: max, load_lb_min_exclusive: weight } = rule;
  if (max === undefined) {
    return weight === null
      ? t("methodology.load.anyLoad", { id, min, unit, result })
      : t("methodology.load.heavyLoadOpen", {
          id,
          min,
          unit,
          load: NUMBER.format(weight),
          result,
        });
  }
  return weight === null
    ? t("methodology.load.anyLoadBetween", { id, min, max, unit, result })
    : t("methodology.load.heavyLoad", { id, min, max, unit, load: NUMBER.format(weight), result });
}

/** Every load rule as a sentence, in the order the rules file lists them. */
export function loadRuleSentences(rules: RiskRules): readonly string[] {
  return rules.load_rules.map((rule) => loadRuleSentence(rules, rule));
}

/** The load rules that depend on the weight of the load, as sentences: what a heavy truck adds to the wind rules. */
export function heavyLoadSentences(rules: RiskRules): readonly string[] {
  return rules.load_rules
    .filter((rule) => rule.load_lb_min_exclusive !== null)
    .map((rule) => loadRuleSentence(rules, rule));
}

/** The weights a load has to be over, in words: "30,000 lb and 40,000 lb"; `null` if no rule has one. */
export function loadLimits(rules: RiskRules): string | null {
  const limits = [
    ...new Set(
      rules.load_rules.flatMap((rule) =>
        rule.load_lb_min_exclusive === null ? [] : [rule.load_lb_min_exclusive],
      ),
    ),
  ].sort((a, b) => a - b);
  return limits.length === 0 ? null : LIST.format(limits.map((limit) => NUMBER.format(limit)));
}

/** What the loads field takes and what the engine adds to it, as the load section's introduction. */
export function loadIntro(rules: RiskRules): string {
  return t("methodology.load.intro", { tare: NUMBER.format(rules.assumed_tare_lb) });
}

/** The accepted load range, in words. */
export function loadRange(rules: RiskRules): string {
  return t("methodology.load.range", {
    min: NUMBER.format(rules.load_limits_lb.min),
    max: NUMBER.format(rules.load_limits_lb.max),
  });
}

/** How far each factor is rounded before its level is chosen, in words. */
export function precisionPhrase(rules: RiskRules): string {
  const parts = RISK_FACTORS.map((factor, position) => {
    const { label, unit, precision } = rules.factors[factor];
    const key =
      position === 0
        ? "methodology.choices.quantization.first"
        : "methodology.choices.quantization.next";
    return t(key, { factor: label.toLowerCase(), precision, unit });
  });
  return LIST.format(parts);
}

/** One ranking key and the words for it. */
export interface RankingEntry {
  readonly id: string;
  readonly text: string;
}

/**
 * The ranking keys in the order the rules file gives them.
 *
 * @throws {Error} If the rules file names a key this page has no words for: the page would
 *   otherwise leave out part of the ranking without saying so.
 */
export function rankingEntries(rules: RiskRules): readonly RankingEntry[] {
  return rules.ranking.keys.map((id) => {
    if (!isRankingKey(id)) {
      throw new Error(`The ranking key "${id}" has no words on the methodology page.`);
    }
    return { id, text: t(RANKING_KEY_TEXT[id]) };
  });
}

/** How small a difference has to be to be ignored when routes are compared, in words. */
export function toleranceSentence(rules: RiskRules): string {
  const { miles, avg_risk: risk, duration_s: seconds } = rules.ranking.tolerances;
  return t("methodology.ranking.tolerances", { miles, risk, seconds });
}

/** The questions answered at the end of the page. */
export const FAQ_IDS = ["ranking", "levels", "load", "weather", "breaks"] as const;

/** One of {@link FAQ_IDS}. */
export type FaqId = (typeof FAQ_IDS)[number];

/** The question. */
export function faqQuestion(id: FaqId): string {
  return t(`methodology.faq.${id}.q`);
}

/**
 * The answer. The one about loads is written from the load rules in the rules file, so the numbers
 * it quotes are the numbers the engine uses.
 */
export function faqAnswer(id: FaqId, rules: RiskRules): string {
  return id === "load"
    ? t("methodology.faq.load.a", { rules: heavyLoadSentences(rules).join(" ") })
    : t(`methodology.faq.${id}.a`);
}
