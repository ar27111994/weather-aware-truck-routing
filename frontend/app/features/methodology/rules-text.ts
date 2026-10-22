import type { LoadRule, RiskBand, RiskFactor, RiskLevel, RiskRules } from "../../api/contract";
import { RISK_FACTORS } from "../../api/vocabulary";
import { t, type StringKey } from "../../design-system/foundation/strings";

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
 * One band in words, read off its edges: "under 25", "25 to under 35", "0.50 to 1.00",
 * "55 or more", "over 1.00".
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
  if (from !== undefined) return t("methodology.rules.band.atLeast", { min: edge(from) });
  if (above !== undefined) return t("methodology.rules.band.over", { min: edge(above) });
  if (below !== undefined) return t("methodology.rules.band.under", { max: edge(below) });
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

/** The factors' values that stay in their band exactly on its upper edge, in words. */
export function boundaryExceptions(rules: RiskRules): string {
  const exceptions = RISK_FACTORS.flatMap((factor) => {
    const { label, unit, bands } = rules.factors[factor];
    const decimals = edgeDecimals(bands);
    return bands.flatMap((band) =>
      band.max_inclusive === undefined
        ? []
        : [
            t("methodology.boundaries.exception", {
              factor: label.toLowerCase(),
              value: band.max_inclusive.toFixed(decimals),
              unit,
            }),
          ],
    );
  });
  return LIST.format(exceptions);
}

function levelName(rules: RiskRules, level: RiskLevel): string {
  return rules.levels.find((candidate) => candidate.id === level)?.label ?? level;
}

/** One load rule as a sentence. */
function loadRuleSentence(rules: RiskRules, rule: LoadRule): string {
  const { unit } = rules.factors[rule.factor];
  const result = levelName(rules, rule.result);
  if (rule.load_lb_min_exclusive === null || rule.max_exclusive === undefined) {
    return t("methodology.load.anyLoad", { id: rule.id, min: rule.min_inclusive, unit, result });
  }
  return t("methodology.load.heavyLoad", {
    id: rule.id,
    min: rule.min_inclusive,
    max: rule.max_exclusive,
    unit,
    load: NUMBER.format(rule.load_lb_min_exclusive),
    result,
  });
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
