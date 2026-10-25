import type { LoadRule, RiskFactor, RiskLevel, RiskRules } from "../../api/contract";
import { RISK_FACTORS } from "../../api/vocabulary";
import { t, type StringKey } from "../../design-system/foundation/strings";
import {
  bandText,
  boundaryGroups,
  edgeDecimals,
  exceptionClause,
  staysText,
} from "../../lib/boundary-text";
import { riskLevelInfo } from "../../lib/risk";

// The boundary sentences are written in lib/ because the legend needs them too and the style guide
// may not import a feature (D-61). The methodology page and its markdown still read them from here.
export { bandEdgesText, boundaryRule } from "../../lib/boundary-text";

/** The page is English and its numbers are written one way, so the prerendered text never differs from the browser's. */
const NUMBER = new Intl.NumberFormat("en-US");
const LIST = new Intl.ListFormat("en-US", { style: "long", type: "conjunction" });
/** The page's prose lists have no comma before "and" ("wind, rain and snow"); en-GB writes them so. */
const PROSE_LIST = new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" });

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

/**
 * One load rule as a sentence. Its two conditions are worded on their own: the wind range (closed
 * above by `max_exclusive`, or open) and the weight (any load, or over a limit). A rule that has
 * either one has to say so, or the page would state a rule the engine does not apply.
 */
function loadRuleSentence(rules: RiskRules, rule: LoadRule): string {
  const { unit } = rules.factors[rule.factor];
  const result = riskLevelInfo(rule.result, rules).label;
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

/** The names of the five levels as the rules file writes them, lowest first (the schema fixes the order). */
export function levelNames(rules: RiskRules): readonly string[] {
  return rules.levels.map((level) => level.label);
}

/** The weather factors as the rules file names them, in lower case, in a list: "wind, rain and snow". */
function factorNames(rules: RiskRules): string {
  return PROSE_LIST.format(RISK_FACTORS.map((factor) => rules.factors[factor].label.toLowerCase()));
}

/**
 * How the factors make a level, and what a missing one does, as the risk table's paragraph says it.
 * The names come from the rules file. "All three" is the schema's: it allows these factors only.
 */
export function factorRule(rules: RiskRules): string {
  return t("methodology.rules.factors", { factors: factorNames(rules) });
}

/**
 * Assumption D-01, "each band includes its lower number", as the rules file has it. D-01 is the
 * default for the numbers that the brief lists. An edge that the brief writes as an open range
 * (">1.00") is the brief's own word and no exception to D-01: the boundary rule says it. Any other
 * edge that a band does not include is an exception, and it is named here.
 */
export function lowerNumberRule(rules: RiskRules): string {
  const groups = boundaryGroups(rules)
    .map((group) => ({ ...group, stays: group.stays.filter((stay) => !stay.briefSaysOver) }))
    .filter((group) => group.stays.length > 0);
  return t("methodology.assumptions.d01", { exceptions: exceptionClause(groups, staysText) });
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
 * it quotes are the numbers the engine uses; the one about the levels, from their names and the
 * names of the factors. "Five ranges" is the schema's: it allows five bands for each factor.
 */
export function faqAnswer(id: FaqId, rules: RiskRules): string {
  if (id === "load") {
    return t("methodology.faq.load.a", { rules: heavyLoadSentences(rules).join(" ") });
  }
  if (id === "levels") {
    return t("methodology.faq.levels.a", {
      levels: PROSE_LIST.format(levelNames(rules)),
      factors: factorNames(rules),
      lowest: riskLevelInfo("low", rules).label,
    });
  }
  return t(`methodology.faq.${id}.a`);
}
