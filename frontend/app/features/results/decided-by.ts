import type { DecidedBy, Plan } from "../../api/contract";
import { t, type StringKey } from "../../design-system/foundation/strings";
import { at } from "../../lib/checked";
import { formatDuration, formatMiles } from "../../lib/format";
import { riskLabel } from "../../lib/risk";

/**
 * Plain-English reason for each way the ranking can be decided. `satisfies` makes the compiler
 * reject a value of `DecidedBy` without a line here: a new ranking key in the contract cannot ship
 * without words (D-24, D-31).
 */
export const DECIDED_BY_COPY = {
  no_travel_mi: "rec.decidedBy.no_travel_mi",
  coverage: "rec.decidedBy.coverage",
  severe_mi: "rec.decidedBy.severe_mi",
  high_mi: "rec.decidedBy.high_mi",
  avg_risk: "rec.decidedBy.avg_risk",
  duration_s: "rec.decidedBy.duration_s",
  tie: "rec.decidedBy.tie",
  only_route: "rec.decidedBy.only_route",
} as const satisfies Record<DecidedBy, StringKey>;

/** The words for a `decided_by` value. */
export function decidedByText(decidedBy: DecidedBy): string {
  return t(DECIDED_BY_COPY[decidedBy]);
}

/** The levels a "avoids N miles" sentence can name, by the ranking key that decided. */
const AVOIDED_LEVEL = { no_travel_mi: "no_travel", severe_mi: "severe", high_mi: "high" } as const;

function averageRisk(value: number): string {
  return value.toFixed(3);
}

/**
 * What choosing the recommended route costs and buys, against the fastest one (DESIGN.md section
 * 13): `Fastest route`, or `+38 min vs fastest, avoids 12.5 Severe miles`. The fastest route is the
 * one with the least `duration_s` (the better rank on a tie). `null` when the plan has one route:
 * there is nothing to compare it with.
 */
export function tradeoffText(plan: Plan): string | null {
  if (plan.routes.length < 2) return null;
  const recommended = at(plan.routes, 0);
  const fastest = plan.routes.reduce((best, route) =>
    route.duration_s < best.duration_s ? route : best,
  );
  if (fastest === recommended) return t("rec.tradeoff.fastest");
  const slower = formatDuration(recommended.duration_s - fastest.duration_s);
  let text = t("rec.tradeoff.slower", { delta: slower });
  const key = plan.recommendation.decided_by;
  if (key === "no_travel_mi" || key === "severe_mi" || key === "high_mi") {
    const level = AVOIDED_LEVEL[key];
    const avoided = fastest.stats.miles_by_level[level] - recommended.stats.miles_by_level[level];
    if (avoided > 0) {
      text += t("rec.tradeoff.avoids", {
        miles: formatMiles(avoided, { unit: false }),
        level: riskLabel(level),
      });
    }
  } else if (
    key === "avg_risk" &&
    fastest.stats.avg_risk !== null &&
    recommended.stats.avg_risk !== null &&
    fastest.stats.avg_risk > recommended.stats.avg_risk
  ) {
    text += t("rec.tradeoff.lowerAvg", {
      rec: averageRisk(recommended.stats.avg_risk),
      fastest: averageRisk(fastest.stats.avg_risk),
    });
  }
  return text;
}

/**
 * When the coverage key decided (D-31), the route that lacked the data and how much of it: "Route
 * B has no weather data for 34% of its miles ...". `null` for any other plan, or when no other
 * route is missing weather (the contract guarantees one is; a plan that breaks it gets no sentence
 * rather than an invented one).
 */
export function coverageDetail(plan: Plan): string | null {
  if (plan.recommendation.decided_by !== "coverage") return null;
  let worst: { readonly routeId: string; readonly share: number } | null = null;
  for (const route of plan.routes) {
    if (route.route_id === plan.recommendation.route_id || route.stats.unknown_mi <= 0) continue;
    const share = route.stats.unknown_mi / route.distance_mi;
    if (worst === null || share > worst.share) worst = { routeId: route.route_id, share };
  }
  if (worst === null) return null;
  return t("rec.coverageDetail", {
    route: worst.routeId,
    percent: Math.round(worst.share * 100),
  });
}
