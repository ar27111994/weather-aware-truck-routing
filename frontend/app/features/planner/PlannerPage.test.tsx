import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import type { ReactElement } from "react";
import { I18nProvider } from "react-aria";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { renderWithApi, startMockApi } from "../../../test/api";
import { DENVER, SLC, requestFor } from "../../../test/plans";
import { errorFixtures, problemResponse } from "../../api/mocks/handlers";
import { tripStore } from "../../state";
import { PlannerPage } from "./PlannerPage";
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

/** What the page asked to be scrolled into view: `this` of each call is the element. */
let scrollIntoView: MockInstance<Element["scrollIntoView"]>;

/** Planning a trip is the slowest step of the page; a machine running other jobs can be slower still. */
const findHeadline = (): Promise<HTMLElement> =>
  screen.findByText(HEADLINE, {}, { timeout: 15_000 });

beforeEach(() => {
  localStorage.clear();
  // jsdom has no Web Animations API; React Aria's sliding tab indicator asks for the animations.
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: (): Animation[] => [],
  });
  // ... and no scrolling: the page scrolls what it shows, and the tests watch it ask.
  scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
  act(() => {
    tripStore.actions.selectRoute(null);
  });
});

afterEach(() => {
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  scrollIntoView.mockRestore();
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

  // The sheet is the panel on every screen (D-47): the style sheet draws it over the map on a phone
  // and beside it from 1024 px. There is nothing for the page to swap, so there is no width at which
  // the form could be rebuilt under the visitor's fingers.
  it("keeps the panel in one sheet, marked as the side panel from 1024 px, with the form in it", async () => {
    renderPlanner();

    const sheet = await screen.findByRole("region", { name: "Trip planner" });
    expect(sheet).toHaveAttribute("data-wide", "panel");
    expect(
      within(sheet).getByRole("button", { name: /(Expand|Collapse) panel/u }),
    ).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Plan routes" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Trip planner" })).toBe(sheet);
    });
  });
});

describe("PlannerPage: the empty state", () => {
  it("fills the first demo scenario into the form", async () => {
    const user = userEvent.setup();
    renderPlanner();
    const source = screen.getByRole("button", { name: /Weather source/u });
    expect(source).toHaveTextContent("Live forecast");

    // The scenarios arrive after the first render; pressing again is harmless until they have.
    await waitFor(async () => {
      await user.click(screen.getByRole("button", { name: "Try a demo scenario" }));
      expect(source).toHaveTextContent("Calm");
    });
  });

  it("does nothing while the scenarios have not arrived", async () => {
    api.server.use(http.get("*/api/v1/scenarios", () => new Promise<Response>(() => undefined)));
    const user = userEvent.setup();
    renderPlanner();

    await user.click(screen.getByRole("button", { name: "Try a demo scenario" }));

    expect(screen.getByRole("button", { name: /Weather source/u })).toHaveTextContent(
      "Live forecast",
    );
  });
});

describe("PlannerPage: planning a trip", () => {
  it("shows the progress while the plan is made, then the answer, and puts the plan in the address", async () => {
    // The answer waits for the test, not for a timer: however slow the machine is, the plan cannot
    // be finished before the page has been looked at while it is still being made.
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    api.server.use(
      http.post("*/api/v1/plans", async () => {
        await answered;
        return undefined;
      }),
    );
    const user = userEvent.setup();
    renderPlanner(TRIP);

    await user.click(screen.getByRole("button", { name: "Plan routes" }));

    try {
      expect(await screen.findByText("Routing, weather, scoring")).toBeInTheDocument();
    } finally {
      answer();
    }
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

  it("announces a plan with no safe route as a warning, not as a recommendation", async () => {
    const user = userEvent.setup();
    renderPlanner(
      buildTripSearch({
        origin: SLC,
        destination: DENVER,
        load: 38_000,
        interval: 50,
        scenario: "no-safe-route",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Plan routes" }));

    await waitFor(() => {
      const statuses = screen.getAllByRole("status").map((status) => status.textContent);
      expect(statuses.join(" ")).toContain(
        "No route is clear of No Travel conditions. Do not depart as planned.",
      );
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

  // The sheet keeps the scroll position the form had (the visitor scrolled down to Plan routes), and
  // a plan is longer than the form: left alone the visitor lands in the middle of the results, or at
  // the end of the checkpoint table when the browser keeps the footer where it was as they load.
  it("brings the top of the panel into view when a plan arrives", async () => {
    const made = await api.client.createPlan(requestFor({ sampling_interval_mi: 50 }));

    renderPlanner(buildTripSearch({ origin: SLC, destination: DENVER, plan: made.plan_id }));
    await findHeadline();

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById("planner"));
  });

  it("does not scroll the panel while there is no plan to show", async () => {
    renderPlanner();
    expect(await screen.findByText("Plan around the weather.")).toBeInTheDocument();

    expect(scrollIntoView).not.toHaveBeenCalled();
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

  // R4-07: the radio group of the interval has no error text of its own; the form ties it.
  it("announces a 422 on the interval with its group and moves the keyboard there", async () => {
    api.server.use(
      http.post("*/api/v1/plans", () =>
        problemResponse(422, "invalid_sampling_interval", "Invalid request", {
          errors: [
            {
              loc: ["body", "sampling_interval_mi"],
              msg: "sampling_interval_mi must be 10, 25 or 50",
              type: "value_error",
            },
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    renderPlanner(TRIP);

    await user.click(screen.getByRole("button", { name: "Plan routes" }));

    const group = await screen.findByRole("radiogroup", { name: "Weather check every" });
    await waitFor(() => {
      expect(group).toHaveAttribute("aria-invalid", "true");
    });
    expect(group).toHaveAccessibleDescription(/Choose 10, 25 or 50 miles./u);
    await waitFor(() => {
      expect(within(group).getByRole("radio", { checked: true })).toHaveFocus();
    });
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

    expect(
      await screen.findByText("Forecast map unavailable", {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(HEADLINE)).toBeInTheDocument();
    failing = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(
      () => {
        expect(screen.queryByText("Forecast map unavailable")).not.toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
  });
});
