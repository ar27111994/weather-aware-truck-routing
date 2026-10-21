import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { DecidedBy, Plan } from "../../api/contract";
import { at } from "../../lib/checked";
import { onlyRoutePlan, planFor } from "../../../test/plans";
import { RecommendationSummary } from "./RecommendationSummary";

function decided(plan: Plan, decidedBy: DecidedBy, rationale: string[] = []): Plan {
  return {
    ...plan,
    recommendation: { ...plan.recommendation, decided_by: decidedBy, rationale, warnings: [] },
    warnings: [],
  };
}

describe("RecommendationSummary", () => {
  it("names the recommended route, what decided it and what it costs against the fastest route", () => {
    const plan = decided(planFor("severe-on-fastest"), "severe_mi", [
      "Route B avoids 12.5 severe miles that Route A crosses.",
      "+38 min vs the fastest option.",
    ]);

    render(<RecommendationSummary plan={plan} />);

    const region = screen.getByRole("region", { name: "Recommendation" });
    expect(
      within(region).getByText(`Take Route ${plan.recommendation.route_id}.`),
    ).toBeInTheDocument();
    expect(within(region).getByText("Decided by")).toBeInTheDocument();
    expect(within(region).getByText("Fewest Severe miles")).toBeInTheDocument();
    expect(within(region).getByText(/vs fastest/u)).toBeInTheDocument();
  });

  it("shows the API's rationale sentences verbatim and in order", () => {
    const sentences = ["First sentence about every route.", "Second sentence about another route."];

    render(<RecommendationSummary plan={decided(planFor("mixed"), "high_mi", sentences)} />);

    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(sentences);
  });

  it("leaves the list out when the API wrote no rationale", () => {
    render(<RecommendationSummary plan={decided(planFor("mixed"), "tie")} />);

    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("says plainly that no route is clear when the best one still crosses No Travel", () => {
    const plan = planFor("no-safe-route");

    render(<RecommendationSummary plan={plan} />);

    expect(
      screen.getByText(`No route is clear. Least risky: Route ${plan.recommendation.route_id}.`),
    ).toBeInTheDocument();
  });

  it("says a single route has no alternative to compare, and offers no trade-off (D-24)", () => {
    render(<RecommendationSummary plan={onlyRoutePlan()} />);

    expect(
      screen.getByText(
        "Only one route connects these points, so there is no alternative to compare",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/vs fastest/u)).not.toBeInTheDocument();
    expect(screen.queryByText("Fastest route")).not.toBeInTheDocument();
  });

  it("explains a recommendation decided by weather coverage, naming the route that lacks data (D-31)", () => {
    const base = decided(planFor("mixed"), "coverage");
    const [first, second, ...rest] = base.routes;
    if (first === undefined || second === undefined) throw new Error("fewer than two routes");
    const gap = { ...second, distance_mi: 400, stats: { ...second.stats, unknown_mi: 136 } };
    const plan = { ...base, routes: [first, gap, ...rest] };

    render(<RecommendationSummary plan={plan} />);

    expect(screen.getByText("Most complete weather data")).toBeInTheDocument();
    expect(
      screen.getByText(
        `Route ${gap.route_id} has no weather data for 34% of its miles, so its risk cannot be compared fairly.`,
      ),
    ).toBeInTheDocument();
  });

  it("lists each distinct warning once, without repeating the scenario notice", () => {
    const plan = {
      ...planFor("calm"),
      warnings: [
        "Simulated weather. Not a forecast.",
        "Truck restrictions are not applied.",
        "Weather is missing at 2 of 14 checkpoints.",
      ],
    };
    const warned = {
      ...plan,
      recommendation: {
        ...plan.recommendation,
        warnings: ["Truck restrictions are not applied.", "Route B: weather is missing."],
      },
    };

    render(<RecommendationSummary plan={warned} />);

    const warnings = screen.getAllByRole("status").map((item) => item.textContent);
    expect(warnings).toEqual([
      "Truck restrictions are not applied.",
      "Weather is missing at 2 of 14 checkpoints.",
      "Route B: weather is missing.",
    ]);
  });

  it("shows no warning list when there is nothing to warn about", () => {
    render(<RecommendationSummary plan={decided(planFor("calm"), "tie")} />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps the fastest-route wording when the recommended route is the fastest", () => {
    const base = decided(planFor("calm"), "severe_mi");
    const routes = base.routes.map((route, index) => ({
      ...route,
      duration_s: 3_000 + index * 600,
    }));

    render(<RecommendationSummary plan={{ ...base, routes }} />);

    expect(screen.getByText("Fastest route")).toBeInTheDocument();
    expect(at(routes, 0).recommended).toBe(true);
  });
});
