import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Plan, Route } from "../../api/contract";
import { at } from "../../lib/checked";
import { onlyRoutePlan, planFor } from "../../../test/plans";
import { PlanBanners } from "./PlanBanners";

/** A plan with live weather (no scenario), every checkpoint Low and three routes. */
function quietPlan(): Plan {
  const plan = planFor("calm");
  return { ...plan, sources: { ...plan.sources, scenario: null } };
}

/** The route with its first `count` checkpoints stripped of a level, as if the forecast were missing. */
function withUnknown(route: Route, count: number): Route {
  return {
    ...route,
    checkpoints: route.checkpoints.map((checkpoint, index) =>
      index < count ? { ...checkpoint, risk: { ...checkpoint.risk, level: null } } : checkpoint,
    ),
  };
}

function withUnknownCheckpoints(plan: Plan, count: number): Plan {
  const [first, ...rest] = plan.routes;
  if (first === undefined) throw new Error("no routes");
  return { ...plan, routes: [withUnknown(first, count), ...rest] };
}

describe("PlanBanners", () => {
  it("shows nothing for a plan that needs no notice", () => {
    const { container } = render(<PlanBanners plan={quietPlan()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("marks a scenario plan as simulated, with the scenario's name (D-13)", () => {
    render(<PlanBanners plan={planFor("calm")} scenarioName="Calm" />);

    const banner = screen.getByRole("status");
    expect(within(banner).getByText("Simulated weather. Not a forecast.")).toBeInTheDocument();
    expect(banner).toHaveTextContent("Scenario: Calm.");
    expect(banner).toHaveTextContent("Do not use them to plan a real trip.");
  });

  it("names the scenario by its id until the scenarios have loaded", () => {
    render(<PlanBanners plan={planFor("calm")} />);

    expect(screen.getByRole("status")).toHaveTextContent("Scenario: calm.");
  });

  it("tells the driver not to depart when no route is clear, with the miles the least risky route crosses", () => {
    const plan = planFor("no-safe-route");
    const best = at(plan.routes, 0);

    render(<PlanBanners plan={plan} scenarioName="No safe route" />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Do not depart on these routes");
    expect(alert).toHaveTextContent(`Route ${best.route_id}, still has `);
    expect(alert).toHaveTextContent(
      `${best.stats.miles_by_level.no_travel.toFixed(1)} No Travel miles`,
    );
  });

  it("offers Change departure on the do-not-depart banner when the page can act on it", async () => {
    const onChangeDeparture = vi.fn();
    render(<PlanBanners plan={planFor("no-safe-route")} onChangeDeparture={onChangeDeparture} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Change departure" }));

    expect(onChangeDeparture).toHaveBeenCalledOnce();
  });

  it("leaves the action out when the page cannot act on it", () => {
    render(<PlanBanners plan={planFor("no-safe-route")} />);

    expect(screen.queryByRole("button", { name: "Change departure" })).not.toBeInTheDocument();
  });

  it("says when fewer than three routes were found, in the singular for one", () => {
    const plan = quietPlan();
    const two = { ...plan, routes: plan.routes.slice(0, 2) };

    const { rerender } = render(<PlanBanners plan={two} />);
    expect(screen.getByText("Fewer than three routes")).toBeInTheDocument();
    expect(
      screen.getByText("Only 2 distinct routes were available for this trip."),
    ).toBeInTheDocument();

    rerender(<PlanBanners plan={onlyRoutePlan()} scenarioName="Calm" />);
    expect(
      screen.getByText("Only 1 distinct route was available for this trip."),
    ).toBeInTheDocument();
  });

  it.each([
    [1, "1 checkpoint has no forecast. It is marked Unknown and is not counted as Low."],
    [3, "3 checkpoints have no forecast. They are marked Unknown and are not counted as Low."],
  ])(
    "counts the %i checkpoint(s) with no forecast on the recommended route, never calling them Low",
    (count, sentence) => {
      render(<PlanBanners plan={withUnknownCheckpoints(quietPlan(), count)} />);

      expect(screen.getByText("Some weather data is missing")).toBeInTheDocument();
      expect(screen.getByText(sentence)).toBeInTheDocument();
    },
  );

  it("ignores checkpoints without weather on routes that were not recommended", () => {
    const plan = quietPlan();
    const [first, second, ...rest] = plan.routes;
    if (first === undefined || second === undefined) throw new Error("fewer than two routes");
    const shaped = { ...plan, routes: [first, withUnknown(second, 2), ...rest] };

    const { container } = render(<PlanBanners plan={shaped} />);

    expect(container).toBeEmptyDOMElement();
  });
});
