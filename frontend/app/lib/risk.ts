/**
 * Risk-level metadata, rule texts and factor classification, all read from the shared
 * `shared/risk-rules.json` (the single source of truth for both stacks). No threshold is written
 * in this file: changing a number in the JSON changes the app.
 */
import riskRulesJson from "../../../shared/risk-rules.json";
import {
  RISK_LEVELS,
  riskRulesSchema,
  type NullableRiskLevel,
  type RiskBand,
  type RiskFactor,
  type RiskLevel,
  type RiskRules,
} from "../api/contract";

/** The bundled rules, validated at load time (a malformed file fails fast with a clear error). */
export const RISK_RULES: RiskRules = riskRulesSchema.parse(riskRulesJson);

/** One risk level's metadata. */
export interface RiskLevelInfo {
  readonly id: RiskLevel;
  readonly ordinal: number;
  readonly label: string;
}

/** Level metadata in ascending severity. */
export const RISK_LEVEL_INFO: readonly RiskLevelInfo[] = [...RISK_RULES.levels].sort(
  (a, b) => a.ordinal - b.ordinal,
);

/** Allowed load weight range in lb, for forms. */
export const LOAD_LIMITS_LB = RISK_RULES.load_limits_lb;
/** Checkpoint spacing choices in miles, for forms. */
export const SAMPLING_INTERVALS_MI: readonly number[] = RISK_RULES.sampling_intervals_mi;
/** The preselected checkpoint spacing. */
export const DEFAULT_SAMPLING_INTERVAL_MI = RISK_RULES.default_sampling_interval_mi;

/** Metadata of `level`. */
export function riskLevelInfo(level: RiskLevel, rules: RiskRules = RISK_RULES): RiskLevelInfo {
  const info = rules.levels.find((candidate) => candidate.id === level);
  return info ?? { id: level, ordinal: RISK_LEVELS.indexOf(level), label: level };
}

/** Ordinal 0 (low) to 4 (no travel). */
export function riskOrdinal(level: RiskLevel): number {
  return riskLevelInfo(level).ordinal;
}

/** Display label; `null` (missing weather) is "Unknown", never "Low". */
export function riskLabel(level: NullableRiskLevel): string {
  return level === null ? "Unknown" : riskLevelInfo(level).label;
}

/** Orders two levels by severity (negative when `a` is milder). */
export function compareRiskLevels(a: RiskLevel, b: RiskLevel): number {
  return riskOrdinal(a) - riskOrdinal(b);
}

/** The five band captions of a factor as the brief writes them (`"<25 mph"`, `"25–34"`, ...). */
export function bandLabels(factor: RiskFactor, rules: RiskRules = RISK_RULES): readonly string[] {
  return rules.factors[factor].brief_labels;
}

/** The brief's wording of a load rule (`"45–54 mph + >30,000 lb → No Travel"`), or `null`. */
export function loadRuleText(id: string, rules: RiskRules = RISK_RULES): string | null {
  return rules.load_rules.find((rule) => rule.id === id)?.brief_text ?? null;
}

/** Round half to even, as the domain does before comparing (DOMAIN-CONTRACT D-02). */
function roundHalfEven(value: number): number {
  const rounded = Math.round(value);
  return Math.abs(value % 1) === 0.5 && rounded % 2 !== 0 ? rounded - 1 : rounded;
}

function inBand(band: RiskBand, quantised: number, scale: number): boolean {
  const q = (bound: number): number => Math.round(bound * scale);
  return (
    (band.min_inclusive === undefined || quantised >= q(band.min_inclusive)) &&
    (band.min_exclusive === undefined || quantised > q(band.min_exclusive)) &&
    (band.max_inclusive === undefined || quantised <= q(band.max_inclusive)) &&
    (band.max_exclusive === undefined || quantised < q(band.max_exclusive))
  );
}

/**
 * The risk level of one factor value, or `null` (unknown) for a missing, negative, NaN or infinite
 * value. Values are compared on a quantised integer scale (tenths of a mph, thousandths of an
 * inch) so float noise can never move a value across a band edge.
 */
export function classifyFactor(
  factor: RiskFactor,
  value: number | null | undefined,
  rules: RiskRules = RISK_RULES,
): NullableRiskLevel {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
  const { precision, bands } = rules.factors[factor];
  const scale = Math.round(1 / precision);
  const quantised = roundHalfEven(value * scale);
  return bands.find((band) => inBand(band, quantised, scale))?.level ?? null;
}
