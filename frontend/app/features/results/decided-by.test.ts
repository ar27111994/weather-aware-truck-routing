import { describe, expect, it } from "vitest";

import { DECIDED_BY, type DecidedBy, type Plan, type Route } from "../../api/contract";
import { t } from "../../design-system/foundation/strings";
import { at } from "../../lib/checked";
import { onlyRoutePlan, planFor } from "../../../test/plans";
import { DECIDED_BY_COPY, coverageDetail, decidedByText, tradeoffText } from "./decided-by";

interface RouteSpec {
  readonly duration_s?: number;
  readonly distance_mi?: number;
  readonly noTravel?: number;
  readonly severe?: number;
  readonly high?: number;
  readonly avg?: number | null;
  readonly unknown?: number;
}

/** A three-route plan whose routes carry exactly the numbers a test names, decided by `decidedBy`. */
function shaped(decidedBy: DecidedBy, specs: readonly RouteSpec[]): Plan {
  const plan = planFor("calm");
  const routes = plan.routes.map((route, position): Route => {
    const spec = specs[position] ?? {};
    return {
      ...route,
      duration_s: spec.duration_s ?? route.duration_s,
      distance_mi: spec.distance_mi ?? route.distance_mi,
      stats: {
        ...route.stats,
        miles_by_level: {
          ...route.stats.miles_by_level,
          no_travel: spec.noTravel ?? 0,
          severe: spec.severe ?? 0,
          high: spec.high ?? 0,
        },
        unknown_mi: spec.unknown ?? 0,
        avg_risk: spec.avg === undefined ? route.stats.avg_risk : spec.avg,
      },
    };
  });
  return { ...plan, routes, recommendation: { ...plan.recommendation, decided_by: decidedBy } };
}

describe("decidedByText", () => {
  it("has words for every way the ranking can be decided, each its own", () => {
    const words = DECIDED_BY.map((key) => decidedByText(key));

    expect(new Set(words).size).toBe(DECIDED_BY.length);
    for (const key of DECIDED_BY) {
      expect(DECIDED_BY_COPY[key]).toBe(`rec.decidedBy.${key}`);
      expect(decidedByText(key)).not.toBe("");
    }
  });

  it("says a single route has nothing to compare (D-24)", () => {
    expect(decidedByText("only_route")).toBe(t("rec.decidedBy.only_route"));
    expect(decidedByText("only_route")).toMatch(/no alternative to compare/);
  });

  it("names the weather-coverage key (D-31)", () => {
    expect(decidedByText("coverage")).toBe("Most complete weather data");
  });
});

describe("tradeoffText", () => {
  it("is empty for a plan with one route: there is nothing to trade", () => {
    expect(tradeoffText(onlyRoutePlan())).toBeNull();
  });

  it("calls the recommended route the fastest when it is", () => {
    const plan = shaped("severe_mi", [
      { duration_s: 3_000 },
      { duration_s: 4_000 },
      { duration_s: 5_000 },
    ]);

    expect(tradeoffText(plan)).toBe("Fastest route");
  });

  it("states the extra time and the Severe miles it avoids (the brief's example)", () => {
    const plan = shaped("severe_mi", [
      { duration_s: 5_280, severe: 0 },
      { duration_s: 3_000, severe: 12.5 },
      { duration_s: 4_000 },
    ]);

    expect(tradeoffText(plan)).toBe("+38 min vs fastest, avoids 12.5 Severe miles");
  });

  it("names the level that decided: No Travel", () => {
    const plan = shaped("no_travel_mi", [
      { duration_s: 4_800, noTravel: 0 },
      { duration_s: 3_000, noTravel: 7.25 },
    ]);

    expect(tradeoffText(plan)).toBe("+30 min vs fastest, avoids 7.3 No Travel miles");
  });

  it("names the level that decided: High", () => {
    const plan = shaped("high_mi", [
      { duration_s: 4_800, high: 1 },
      { duration_s: 3_000, high: 20 },
    ]);

    expect(tradeoffText(plan)).toBe("+30 min vs fastest, avoids 19.0 High miles");
  });

  it("adds no avoided miles when the fastest route is no worse on the deciding level", () => {
    const plan = shaped("severe_mi", [
      { duration_s: 4_800, severe: 3 },
      { duration_s: 5_000, severe: 9 },
      { duration_s: 3_000, severe: 3 },
    ]);

    expect(tradeoffText(plan)).toBe("+30 min vs fastest");
  });

  it("says the average risk fell when average risk decided", () => {
    const plan = shaped("avg_risk", [
      { duration_s: 4_800, avg: 0.0625 },
      { duration_s: 3_000, avg: 0.125 },
    ]);

    expect(tradeoffText(plan)).toBe("+30 min vs fastest, lower average risk (0.063 vs 0.125)");
  });

  it.each([
    ["the fastest route has no average (nothing was assessed)", { avg: null }, { avg: 0.2 }],
    ["the recommended route has no average", { avg: 0.2 }, { avg: null }],
    ["the fastest route is not riskier on average", { avg: 0.1 }, { avg: 0.1 }],
  ])("leaves the average out when %s", (_name, fastest, recommended) => {
    const plan = shaped("avg_risk", [
      { duration_s: 4_800, ...recommended },
      { duration_s: 3_000, ...fastest },
    ]);

    expect(tradeoffText(plan)).toBe("+30 min vs fastest");
  });

  it.each<DecidedBy>(["duration_s", "tie", "coverage"])(
    "states only the extra time when %s decided",
    (decidedBy) => {
      const plan = shaped(decidedBy, [{ duration_s: 4_800 }, { duration_s: 3_000 }]);

      expect(tradeoffText(plan)).toBe("+30 min vs fastest");
    },
  );

  it("breaks a tie between equally fast routes in favour of the better rank", () => {
    const plan = shaped("severe_mi", [
      { duration_s: 3_000 },
      { duration_s: 3_000 },
      { duration_s: 3_000 },
    ]);

    expect(tradeoffText(plan)).toBe("Fastest route");
  });
});

describe("coverageDetail", () => {
  it("is empty unless the coverage key decided", () => {
    expect(coverageDetail(shaped("severe_mi", [{}, { unknown: 100 }]))).toBeNull();
  });

  it("names the route that lacks weather and how much of it", () => {
    const plan = shaped("coverage", [
      { distance_mi: 500, unknown: 0 },
      { distance_mi: 500, unknown: 170 },
      { distance_mi: 500, unknown: 0 },
    ]);

    expect(coverageDetail(plan)).toBe(
      `Route ${at(plan.routes, 1).route_id} has no weather data for 34% of its miles, so its risk cannot be compared fairly.`,
    );
  });

  it("picks the route with the larger gap when two lack weather", () => {
    const plan = shaped("coverage", [
      { distance_mi: 500 },
      { distance_mi: 500, unknown: 100 },
      { distance_mi: 500, unknown: 300 },
    ]);

    expect(coverageDetail(plan)).toContain(
      `Route ${at(plan.routes, 2).route_id} has no weather data for 60% of its miles`,
    );
  });

  it("never blames the recommended route itself", () => {
    const plan = shaped("coverage", [{ distance_mi: 500, unknown: 25 }, { distance_mi: 500 }]);

    expect(coverageDetail(plan)).toBeNull();
  });

  it("says nothing when the plan names coverage but no other route is missing weather", () => {
    expect(coverageDetail(shaped("coverage", [{}, {}, {}]))).toBeNull();
  });
});
