import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, delay, http } from "msw";
import type { ReactElement } from "react";
import { I18nProvider } from "react-aria";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithApi, startMockApi } from "../../../test/api";
import { installMatchMedia, type MatchMediaController } from "../../../test/match-media";
import { DENVER, SLC, requestFor } from "../../../test/plans";
import { errorFixtures, problemResponse } from "../../api/mocks/handlers";
import { tripStore } from "../../state";
import { DESKTOP_QUERY, PlannerPage } from "./PlannerPage";
import { buildTripSearch } from "./trip-url";

// A whole page of react-aria fields and a results panel, on a machine running other jobs.
vi.setConfig({ testTimeout: 30_000 });

const api = startMockApi();
const TRIP = buildTripSearch({
  origin: SLC,
  destination: DENVER,
  load: 38_000,
  interval: 50,
  scenario: "calm",
});
const HEADLINE = /^Take Route [A-C]\.$/u;

/** Shows the address the page keeps, and goes back through the history like the back button. */
function AddressProbe(): ReactElement {
  const { search } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span data-testid="address">{search}</span>
      <button
        type="button"
        onClick={() => {
          void navigate(-1);
        }}
      >
        go back
      </button>
    </>
  );
}

function renderPlanner(search = ""): void {
  renderWithApi(
    <I18nProvider locale="en-US">
      <MemoryRouter initialEntries={[`/${search}`]}>
        <PlannerPage />
        <AddressProbe />
      </MemoryRouter>
    </I18nProvider>,
    api.client,
  );
}

const address = (): string => screen.getByTestId("address").textContent;

/** Planning a trip is the slowest step of the page; a machine running other jobs can be slower still. */
const findHeadline = (): Promise<HTMLElement> =>
  screen.findByText(HEADLINE, {}, { timeout: 15_000 });

let media: MatchMediaController;

beforeEach(() => {
  localStorage.clear();
  media = installMatchMedia({ [DESKTOP_QUERY]: true });
  // jsdom has no Web Animations API; React Aria's sliding tab indicator asks for the animations.
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

describe("PlannerPage: layout", () => {
  it("names the page, the planner and the map, and starts on the empty state", async () => {
    renderPlanner();

    expect(
      screen.getByRole("heading", { level: 1, name: "Haulcast route planner" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Trip planner" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Route map" })).toBeInTheDocument();
    expect(await screen.findByText("Plan around the weather.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plan routes" })).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("keeps the panel beside the map on a desktop and in a draggable sheet on a phone", async () => {
    media.setMatches(DESKTOP_QUERY, false);
    renderPlanner();

    const sheet = await screen.findByRole("region", { name: "Trip planner" });
    await waitFor(() => {
      expect(
        within(sheet).getByRole("button", { name: /(Expand|Collapse) panel/u }),
      ).toBeInTheDocument();
    });
    expect(within(sheet).getByRole("button", { name: "Plan routes" })).toBeInTheDocument();

    act(() => {
      media.setMatches(DESKTOP_QUERY, true);
    });

    const side = await screen.findByRole("region", { name: "Trip planner" });
    expect(
      within(side).queryByRole("button", { name: /(Expand|Collapse) panel/u }),
    ).not.toBeInTheDocument();
    expect(within(side).getByRole("button", { name: "Plan routes" })).toBeInTheDocument();
  });
});

describe("PlannerPage: planning a trip", () => {
  it("shows the progress while the plan is made, then the answer, and puts the plan in the address", async () => {
    api.server.use(
      http.post("*/api/v1/plans", async () => {
        await delay(200);
        return undefined;
      }),
    );
    const user = userEvent.setup();
    renderPlanner(TRIP);

    await user.click(screen.getByRole("button", { name: "Plan routes" }));

    expect(await screen.findByText("Routing, weather, scoring")).toBeInTheDocument();
    expect(await findHeadline()).toBeInTheDocument();
    await waitFor(() => {
      expect(address()).toMatch(/[?&]plan=/u);
    });
    expect(address()).toContain("interval=50");
    expect(address()).toContain("scenario=calm");
    expect(screen.getByRole("heading", { level: 2, name: "Recommendation" })).toBeInTheDocument();
    expect(screen.getByText("Simulated weather. Not a forecast.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit trip" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it("announces the plan in the one live region", async () => {
    const user = userEvent.setup();
    renderPlanner(TRIP);

    await user.click(screen.getByRole("button", { name: "Plan routes" }));

    await waitFor(() => {
      const statuses = screen.getAllByRole("status").map((status) => status.textContent);
      expect(statuses.join(" ")).toMatch(
        /Plan ready\. 3 routes found\. Recommended: Route [A-C]\./u,
      );
    });
    await waitFor(() => {
      const statuses = screen.getAllByRole("status").map((status) => status.textContent);
      expect(statuses.join(" ")).toContain("Forecast map ready.");
    });
  });

  it("restores the plan an address names without making a new one", async () => {
    const made = await api.client.createPlan(requestFor({ sampling_interval_mi: 50 }));
    let posts = 0;
    api.server.use(
      http.post("*/api/v1/plans", () => {
        posts += 1;
        return HttpResponse.error();
      }),
    );

    renderPlanner(
      buildTripSearch({
        origin: SLC,
        destination: DENVER,
        load: 38_000,
        interval: 50,
        scenario: "mixed",
        plan: made.plan_id,
      }),
    );

    expect(await findHeadline()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit trip" })).toBeInTheDocument();
    expect(posts).toBe(0);
  });

  it("says a plan has expired when the address names one the server no longer has", async () => {
    renderPlanner(
      buildTripSearch({ origin: SLC, destination: DENVER, plan: "pln_00000000000000000000000000" }),
    );

    expect(await screen.findByText("This plan has expired")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit trip" })).toBeInTheDocument();
  });

  it("walks back from the plan to the form with the back button", async () => {
    const user = userEvent.setup();
    renderPlanner(TRIP);
    await user.click(screen.getByRole("button", { name: "Plan routes" }));
    expect(await findHeadline()).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "go back" }));

    expect(await screen.findByRole("button", { name: "Plan routes" })).toBeInTheDocument();
    expect(address()).toBe(TRIP);
    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();
  });

  it("opens the form again from the summary, with the trip in it", async () => {
    const user = userEvent.setup();
    renderPlanner(TRIP);
    await user.click(screen.getByRole("button", { name: "Plan routes" }));
    expect(await findHeadline()).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit trip" }));

    const origin = await screen.findByRole("combobox", { name: /^From/u });
    expect(origin).toHaveValue(SLC.label);
    await waitFor(() => {
      expect(origin).toHaveFocus();
    });
  });
});

describe("PlannerPage: when it goes wrong", () => {
  it("marks the field a 422 blames and keeps the form open", async () => {
    api.server.use(errorFixtures.validation422());
    const user = userEvent.setup();
    renderPlanner(TRIP);

    await user.click(screen.getByRole("button", { name: "Plan routes" }));

    expect(
      await screen.findByText("Choose a departure from now up to 5 days ahead."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plan routes" })).toBeInTheDocument();
    expect(address()).toBe(TRIP);
  });

  it("explains a routing outage with the problem panel, and tries again on request", async () => {
    api.server.use(
      http.post(
        "*/api/v1/plans",
        () => problemResponse(502, "routing_unavailable", "Routing provider unavailable", {}),
        { once: true },
      ),
    );
    const user = userEvent.setup();
    renderPlanner(TRIP);
    await user.click(screen.getByRole("button", { name: "Plan routes" }));

    expect(await screen.findByText("Routing is unavailable")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await findHeadline()).toBeInTheDocument();
    expect(screen.queryByText("Routing is unavailable")).not.toBeInTheDocument();
  });

  it("counts down the wait the server asks for when it limits the rate", async () => {
    api.server.use(errorFixtures.rateLimited429({ retryAfterS: 30 }));
    const user = userEvent.setup();
    renderPlanner(TRIP);

    await user.click(screen.getByRole("button", { name: "Plan routes" }));

    expect(await screen.findByText("Too many plans in a row")).toBeInTheDocument();
    expect(screen.getByText(/Wait \d+ s, then try again\./u)).toBeInTheDocument();
  });

  it("keeps the routes when only the forecast map fails, and asks again for it", async () => {
    let failing = true;
    api.server.use(
      http.get("*/api/v1/plans/:id/heatmap", () =>
        failing
          ? problemResponse(502, "weather_unavailable", "Weather unavailable", {})
          : undefined,
      ),
    );
    const user = userEvent.setup();
    renderPlanner(TRIP);
    await user.click(screen.getByRole("button", { name: "Plan routes" }));

    expect(await screen.findByText("Forecast map unavailable")).toBeInTheDocument();
    expect(screen.getByText(HEADLINE)).toBeInTheDocument();
    failing = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(screen.queryByText("Forecast map unavailable")).not.toBeInTheDocument();
    });
  });
});
