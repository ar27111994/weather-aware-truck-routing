import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { at } from "../../lib/checked";
import { expectNoAxeViolations, warmUpAxe } from "../../../test/axe";
import { onlyRoutePlan, planFor } from "../../../test/plans";
import { tripStore } from "../../state";
import { routeCardLabel } from "./route-format";
import { RouteList } from "./RouteList";

// A list of route cards is scanned by axe; a machine running other jobs can take longer than 5 s over it.
vi.setConfig({ testTimeout: 20_000 });

const plan = planFor("severe-on-fastest");

beforeAll(async () => {
  await warmUpAxe();
}, 60_000);

beforeEach(() => {
  act(() => {
    tripStore.actions.selectRoute(null);
  });
});

function cards(): HTMLElement[] {
  return screen.getAllByRole("row");
}

describe("RouteList", () => {
  it("shows one card per route in rank order, each named by its letter and headline numbers", () => {
    render(<RouteList plan={plan} />);

    expect(cards().map((card) => card.getAttribute("aria-label"))).toEqual(
      plan.routes.map(routeCardLabel),
    );
    expect(screen.getByRole("grid", { name: "Routes" })).toBeInTheDocument();
  });

  it("marks only the first route Recommended", () => {
    render(<RouteList plan={plan} />);

    expect(screen.getAllByText("Recommended")).toHaveLength(1);
    expect(within(at(cards(), 0)).getByText("Recommended")).toBeInTheDocument();
  });

  it("shows each route's letter, via summary, distance, drive time, arrival and miles by level", () => {
    render(<RouteList plan={plan} />);

    const first = at(cards(), 0);
    const route = at(plan.routes, 0);
    expect(within(first).getByText(`Route ${route.route_id}`)).toBeInTheDocument();
    expect(within(first).getByText(route.summary)).toBeInTheDocument();
    expect(within(first).getByText("Distance")).toBeInTheDocument();
    expect(within(first).getByText("Drive time")).toBeInTheDocument();
    expect(within(first).getByText("Arrives")).toBeInTheDocument();
    expect(within(first).getByRole("img", { name: /mi/u })).toBeInTheDocument();
    expect(within(first).getByText("Avg risk")).toBeInTheDocument();
    expect(within(first).getByText("Highest level")).toBeInTheDocument();
  });

  it("gives the recommended card its reason: the first rationale sentence and the trade-off", () => {
    render(<RouteList plan={plan} />);

    const first = at(cards(), 0);
    const [sentence] = plan.recommendation.rationale;
    if (sentence === undefined) throw new Error("the fixture plan has no rationale");
    expect(within(first).getByText(sentence)).toBeInTheDocument();
    expect(within(first).getByText(/vs fastest|Fastest route/u)).toBeInTheDocument();
    expect(within(at(cards(), 1)).queryByText(sentence)).not.toBeInTheDocument();
  });

  it("gives the recommended card a reason of one line when only one of the two exists", () => {
    const noRationale = {
      ...plan,
      recommendation: { ...plan.recommendation, rationale: [] },
    };
    const { rerender } = render(<RouteList plan={noRationale} />);
    expect(within(at(cards(), 0)).getByText(/vs fastest|Fastest route/u)).toBeInTheDocument();

    const single = onlyRoutePlan();
    rerender(
      <RouteList
        plan={{
          ...single,
          recommendation: { ...single.recommendation, rationale: ["Only choice."] },
        }}
      />,
    );
    expect(within(at(cards(), 0)).getByText("Only choice.")).toBeInTheDocument();
    expect(within(at(cards(), 0)).queryByText(/vs fastest|Fastest route/u)).not.toBeInTheDocument();
  });

  it("gives the recommended card no reason block when it has nothing to say (a single route, no rationale)", () => {
    render(<RouteList plan={onlyRoutePlan()} />);

    // The only paragraph on the card is the via summary.
    expect(at(cards(), 0).querySelectorAll("p")).toHaveLength(1);
  });

  it("selects the route that is pressed, in the shared trip state", async () => {
    render(<RouteList plan={plan} />);
    const second = at(plan.routes, 1);

    await userEvent.setup().click(at(cards(), 1));

    expect(tripStore.getState().selectedRouteId).toBe(second.route_id);
    expect(at(cards(), 1)).toHaveAttribute("aria-selected", "true");
    expect(at(cards(), 0)).toHaveAttribute("aria-selected", "false");
  });

  it("selects with the keyboard: arrows move between cards, Enter selects", async () => {
    const user = userEvent.setup();
    render(<RouteList plan={plan} />);

    await user.tab();
    await user.keyboard("{ArrowDown}{Enter}");

    expect(tripStore.getState().selectedRouteId).toBe(at(plan.routes, 1).route_id);
  });

  it("selects with Space as well", async () => {
    const user = userEvent.setup();
    render(<RouteList plan={plan} />);

    await user.tab();
    await user.keyboard("{ArrowDown}{ArrowDown} ");

    expect(tripStore.getState().selectedRouteId).toBe(at(plan.routes, 2).route_id);
  });

  it("follows the shared trip state: a route selected elsewhere (the map) shows as selected here", () => {
    render(<RouteList plan={plan} />);

    act(() => {
      tripStore.actions.selectRoute(at(plan.routes, 2).route_id);
    });

    expect(at(cards(), 2)).toHaveAttribute("aria-selected", "true");
  });

  it("keeps the selection when the pressed route is already selected (a selection is never empty)", async () => {
    const user = userEvent.setup();
    render(<RouteList plan={plan} />);
    await user.click(at(cards(), 0));

    await user.click(at(cards(), 0));

    expect(tripStore.getState().selectedRouteId).toBe(at(plan.routes, 0).route_id);
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<RouteList plan={plan} />);

    await expectNoAxeViolations(container);
  });
});
