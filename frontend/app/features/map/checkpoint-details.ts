/**
 * What the checkpoint popover says (DESIGN.md section 9.7), as plain strings built from the plan:
 * the component only lays them out, so every number and word is tested here.
 */
import type { Checkpoint, NullableRiskLevel, Plan, RiskRules, Route } from "../../api/contract";
import { t } from "../../design-system/foundation/strings";
import {
  formatDurationDelta,
  formatFahrenheit,
  formatInchesPerHour,
  formatLocalTime,
  formatMiles,
  formatMph,
  formatUtcOffset,
} from "../../lib/format";
import { RISK_RULES, loadRuleText } from "../../lib/risk";
import type { CheckpointRef } from "../../state/trip-store";

/** One row of the factor table. */
export interface FactorRow {
  readonly key: "wind" | "gust" | "rain" | "snow" | "temp";
  readonly label: string;
  readonly value: string;
  /** The factor's scored level; absent for the rows that are not scored (gusts, temperature). */
  readonly level?: NullableRiskLevel;
  readonly note?: string;
}

/** Everything the popover shows. */
export interface CheckpointDetailsModel {
  readonly routeId: string;
  readonly title: string;
  readonly level: NullableRiskLevel;
  readonly eta: string;
  readonly offset: string;
  readonly afterDeparture: string;
  readonly distance: string;
  readonly rows: readonly FactorRow[];
  readonly loadRule: string;
  readonly reasons: readonly string[];
  readonly validFor: string;
  readonly incomplete: string | null;
}

function find(plan: Plan, ref: CheckpointRef): { route: Route; checkpoint: Checkpoint } | null {
  const route = plan.routes.find((candidate) => candidate.route_id === ref.routeId);
  const checkpoint = route?.checkpoints.find((candidate) => candidate.index === ref.index);
  return route && checkpoint ? { route, checkpoint } : null;
}

function measured(value: number | null, format: (value: number) => string): string {
  return value === null ? t("popover.missing") : format(value);
}

/**
 * The load-rule line: the rule that raised this checkpoint, or "None", with the near-miss note when
 * the wind is inside a rule's band but the load is under its threshold (DESIGN.md section 9.7).
 */
function loadRuleLine(
  checkpoint: Checkpoint,
  loadLb: number,
  rules: RiskRules,
  locale?: string,
): string {
  const applied = checkpoint.risk.load_rule;
  if (applied !== null) return `${applied}: ${loadRuleText(applied, rules) ?? applied}`;
  const wind = checkpoint.weather.wind_mph;
  const near =
    wind === null
      ? undefined
      : rules.load_rules.find(
          (rule) =>
            rule.load_lb_min_exclusive !== null &&
            loadLb <= rule.load_lb_min_exclusive &&
            wind >= rule.min_inclusive &&
            (rule.max_exclusive === undefined || wind < rule.max_exclusive),
        );
  if (near?.load_lb_min_exclusive == null) return t("popover.loadRuleNone");
  const pounds = new Intl.NumberFormat(locale ?? "en-US");
  return t("popover.loadRuleNear", {
    rule: near.id,
    threshold: pounds.format(near.load_lb_min_exclusive),
    load: pounds.format(loadLb),
  });
}

/** The popover model for `ref`, or `null` when the plan has no such checkpoint. */
export function checkpointDetails(
  plan: Plan,
  ref: CheckpointRef,
  locale?: string,
  rules: RiskRules = RISK_RULES,
): CheckpointDetailsModel | null {
  const found = find(plan, ref);
  if (!found) return null;
  const { route, checkpoint } = found;
  const { weather, risk } = checkpoint;
  const options = locale === undefined ? {} : { locale };
  const elapsedS = (Date.parse(checkpoint.eta) - Date.parse(route.departure_time)) / 1000;
  const missing = (["wind", "rain", "snow"] as const)
    .filter((factor) => risk.factors[factor] === null)
    .map((factor) => t(`popover.${factor}`));
  return {
    routeId: route.route_id,
    title: t("popover.title", { n: checkpoint.index + 1, total: route.checkpoints.length }),
    level: risk.level,
    eta: formatLocalTime(checkpoint.eta, checkpoint, options),
    offset: formatUtcOffset(checkpoint.utc_offset_s),
    afterDeparture:
      Math.round(elapsedS / 60) === 0
        ? t("popover.atDeparture")
        : t("popover.afterDeparture", { duration: formatDurationDelta(elapsedS) }),
    distance: t("popover.distanceValue", {
      distance: formatMiles(checkpoint.distance_mi, { ...options, unit: false }),
      owned: formatMiles(checkpoint.owned_mi, { ...options, unit: false }),
    }),
    rows: [
      {
        key: "wind",
        label: t("popover.wind"),
        value: measured(weather.wind_mph, (value) => formatMph(value, options)),
        level: risk.factors.wind,
      },
      {
        // The shared rules score sustained wind (DOMAIN-CONTRACT section 2), so gusts are not scored.
        key: "gust",
        label: t("popover.gust"),
        value: measured(weather.gust_mph, (value) => formatMph(value, options)),
        note: t("popover.gustNote"),
      },
      {
        key: "rain",
        label: t("popover.rain"),
        value: measured(weather.rain_in_hr, (value) => formatInchesPerHour(value, options)),
        level: risk.factors.rain,
      },
      {
        key: "snow",
        label: t("popover.snow"),
        value: measured(weather.snow_in_hr, (value) => formatInchesPerHour(value, options)),
        level: risk.factors.snow,
      },
      {
        key: "temp",
        label: t("popover.temp"),
        value: measured(weather.temperature_f, (value) => formatFahrenheit(value, options)),
      },
    ],
    loadRule: loadRuleLine(checkpoint, plan.request.load_weight_lb, rules, locale),
    reasons: risk.reasons,
    validFor: t("popover.validFor", {
      time: formatLocalTime(weather.valid_time, checkpoint, options),
    }),
    incomplete: risk.incomplete ? t("popover.incomplete", { reason: missing.join(", ") }) : null,
  };
}
