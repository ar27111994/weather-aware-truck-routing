import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../api/errors";
import { at } from "../../lib/checked";
import { expectNoAxeViolations, warmUpAxe } from "../../../test/axe";
import { planFor, shortPlan } from "../../../test/plans";
import { tripStore } from "../../state";
import { ResultsPanel, type ResultsView } from "./ResultsPanel";

/** Eight rows per route are enough, and a 40-row table is slow to render in jsdom. */
const plan = shortPlan(planFor("mixed"), 8);

beforeAll(async () => {
  await warmUpAxe();
}, 60_000);

/** jsdom has no Web Animations API; React Aria's sliding tab indicator asks for the running animations. */
beforeEach(() => {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: (): Animation[] => [],
  });
  act(() => {
    tripStore.actions.selectRoute(null);
  });
});

afterEach(() => {
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

function failed(
  status: number,
  code: string,
  extra: { retryAfterS?: number; requestId?: string } = {},
): ApiError {
  return new ApiError({ status, code, title: "Problem", ...extra });
}

function errorView(
  error: ApiError,
  handlers: { onRetry?: () => void; onEdit?: () => void; interval?: number } = {},
): ResultsView {
  return {
    kind: "error",
    error,
    interval: handlers.interval ?? 25,
    onRetry: handlers.onRetry ?? vi.fn(),
    onEdit: handlers.onEdit ?? vi.fn(),
  };
}

describe("ResultsPanel: empty", () => {
  it("invites a trip, says how it works and offers a demo scenario", async () => {
    const onTryScenario = vi.fn();
    render(<ResultsPanel view={{ kind: "empty", onTryScenario }} />);

    expect(screen.getByText("Plan around the weather.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "How it works" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Try a demo scenario" }));

    expect(onTryScenario).toHaveBeenCalledOnce();
  });
});

describe("ResultsPanel: loading", () => {
  it("shows placeholders the shape of the route cards, and says it is busy", () => {
    const { container } = render(<ResultsPanel view={{ kind: "loading" }} />);

    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  });
});

describe("ResultsPanel: error", () => {
  it("explains a failure no retry can fix and offers editing the trip, with the reference", async () => {
    const onEdit = vi.fn();
    render(
      <ResultsPanel
        view={errorView(failed(422, "no_route_found", { requestId: "req-1234abcd" }), { onEdit })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("No truck route found");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByText("Reference req-1234abcd")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Edit trip" }));

    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("offers Try again for a failure that can pass", async () => {
    const onRetry = vi.fn();
    render(<ResultsPanel view={errorView(failed(502, "routing_unavailable"), { onRetry })} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Routing is unavailable");
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));

    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("leaves the reference out when the server sent none", () => {
    render(<ResultsPanel view={errorView(failed(502, "routing_unavailable"))} />);

    expect(screen.queryByText(/^Reference /u)).not.toBeInTheDocument();
  });

  it("holds Try again back until the Retry-After wait is over, counting it in the message (429)", () => {
    render(<ResultsPanel view={errorView(failed(429, "rate_limited", { retryAfterS: 3 }))} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Wait 3 s, then try again.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
  });

  it("says how many minutes until the forecast capacity is back", () => {
    render(
      <ResultsPanel
        view={errorView(failed(503, "weather_capacity_exhausted", { retryAfterS: 600 }))}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Try again in 10 min.");
  });

  it("names the checkpoint interval that needs too many weather checks", () => {
    render(
      <ResultsPanel view={errorView(failed(422, "too_many_checkpoints"), { interval: 10 })} />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("at a 10-mile interval");
  });

  it("falls back to the generic copy for a problem it has no words for", () => {
    render(<ResultsPanel view={errorView(failed(500, "something_new"))} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
  });
});

describe("ResultsPanel: plan", () => {
  it("shows the recommendation, the route cards and the checkpoint table of the selected route", () => {
    act(() => {
      tripStore.actions.resetForPlan(plan);
    });
    render(<ResultsPanel view={{ kind: "plan", plan }} />);

    const selected = at(plan.routes, 0);
    expect(screen.getByRole("region", { name: "Recommendation" })).toBeInTheDocument();
    expect(screen.getByRole("grid", { name: "Routes" })).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: `Checkpoints for Route ${selected.route_id}` }),
    ).toBeInTheDocument();
  });

  it("follows the selection: another route's checkpoints replace the first's", () => {
    render(<ResultsPanel view={{ kind: "plan", plan }} />);
    const other = at(plan.routes, 2);

    act(() => {
      tripStore.actions.selectRoute(other.route_id);
    });

    expect(
      screen.getByRole("region", { name: `Checkpoints for Route ${other.route_id}` }),
    ).toBeInTheDocument();
  });

  it("shows the first route's details when nothing, or a route not in the plan, is selected", () => {
    act(() => {
      tripStore.actions.selectRoute("Z");
    });
    render(<ResultsPanel view={{ kind: "plan", plan }} />);

    expect(
      screen.getByRole("region", { name: `Checkpoints for Route ${at(plan.routes, 0).route_id}` }),
    ).toBeInTheDocument();
  });

  it("switches between the checkpoints, the risk profile and the trip details", async () => {
    const user = userEvent.setup();
    render(<ResultsPanel view={{ kind: "plan", plan }} />);

    const tabs = screen.getByRole("tablist", { name: "Details of the selected route" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Checkpoints", "Risk profile", "Trip details"]);

    await user.click(screen.getByRole("tab", { name: "Risk profile" }));
    expect(screen.getByRole("listbox", { name: /^Risk along Route/u })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Trip details" }));
    expect(screen.getByText("Gross weight used for routing")).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<ResultsPanel view={{ kind: "plan", plan }} />);

    await expectNoAxeViolations(container);
  });
});
