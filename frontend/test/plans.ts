import { buildPlan } from "../app/api/mocks";
import { type Plan, type PlanLocation, type PlanRequest } from "../app/api/contract";

/** Places the mock backend has recorded routes for. */
export const SLC: PlanLocation = {
  lat: 40.7608,
  lon: -111.891,
  label: "Salt Lake City, Utah, United States",
};
export const DENVER: PlanLocation = {
  lat: 39.7392,
  lon: -104.9903,
  label: "Denver, Colorado, United States",
};
export const CHICAGO: PlanLocation = {
  lat: 41.8781,
  lon: -87.6298,
  label: "Chicago, Illinois, United States",
};

/** A request for the recorded Salt Lake City to Denver trip; override any field. */
export function requestFor(overrides: Partial<PlanRequest> = {}): PlanRequest {
  return {
    origin: SLC,
    destination: DENVER,
    departure_time: "2026-10-20T14:00:00Z",
    load_weight_lb: 38_000,
    sampling_interval_mi: 25,
    scenario: "mixed",
    ...overrides,
  };
}

/** A realistic three-route plan (recorded geometry, scripted weather) for a scenario. */
export function planFor(
  scenario: string | null = "mixed",
  overrides: Partial<PlanRequest> = {},
): Plan {
  return buildPlan(requestFor({ scenario, ...overrides }));
}

/**
 * A plan that has one route and says `only_route`: the mock cannot build one (every recorded trip
 * has three routes), so the first route of a real plan is kept and the recommendation reworded.
 */
export function onlyRoutePlan(): Plan {
  const plan = planFor("calm");
  const [first] = plan.routes;
  if (first === undefined) throw new Error("the mock plan has no routes");
  return {
    ...plan,
    routes: [first],
    recommendation: { ...plan.recommendation, decided_by: "only_route", rationale: [] },
  };
}

/** The route with only its first `count` checkpoints: a table of 40 rows is slow to render in jsdom. */
export function shortRoute(route: Plan["routes"][number], count: number): Plan["routes"][number] {
  return { ...route, checkpoints: route.checkpoints.slice(0, count) };
}

/** The plan with every route cut to its first `count` checkpoints (see {@link shortRoute}). */
export function shortPlan(plan: Plan, count: number): Plan {
  return { ...plan, routes: plan.routes.map((route) => shortRoute(route, count)) };
}
