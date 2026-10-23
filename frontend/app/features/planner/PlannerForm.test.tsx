import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import type { ReactElement } from "react";
import { I18nProvider } from "react-aria";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlanRequest } from "../../api/contract";
import { DENVER, SLC } from "../../../test/plans";
import { renderWithApi, startMockApi } from "../../../test/api";
import type { Clock } from "./departure";
import { PlannerForm } from "./PlannerForm";
import { RECENT_PLACES_KEY } from "./recent-places";
import { usePlannerForm } from "./usePlannerForm";
import type { TripUrlState } from "./trip-url";

// A form of six react-aria fields on a machine running other jobs: the first render alone can pass 5 s.
vi.setConfig({ testTimeout: 20_000 });

const api = startMockApi();
const CLOCK: Clock = { now: () => new Date("2026-10-20T14:00:42Z"), timeZone: "America/Denver" };
const FILLED: TripUrlState = { origin: SLC, destination: DENVER, load: 38_000 };

function Harness({
  defaults = {},
  isSubmitting = false,
  onSubmit,
}: {
  readonly defaults?: TripUrlState;
  readonly isSubmitting?: boolean;
  readonly onSubmit: (request: PlanRequest) => void;
}): ReactElement {
  const form = usePlannerForm(defaults, CLOCK);
  return (
    <I18nProvider locale="en-US">
      <PlannerForm form={form} clock={CLOCK} isSubmitting={isSubmitting} onSubmit={onSubmit} />
    </I18nProvider>
  );
}

function setup(props: Partial<Parameters<typeof Harness>[0]> = {}): {
  onSubmit: ReturnType<typeof vi.fn<(request: PlanRequest) => void>>;
} {
  const onSubmit = vi.fn<(request: PlanRequest) => void>();
  renderWithApi(<Harness onSubmit={onSubmit} {...props} />, api.client);
  return { onSubmit };
}

describe("PlannerForm", () => {
  // Picking a place remembers it (R1); one test must not start with another one's recent places.
  beforeEach(() => {
    localStorage.clear();
  });

  it("has every input of R1, each with a visible label", () => {
    setup();

    expect(screen.getByRole("combobox", { name: /^From/u })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^To/u })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Swap origin and destination" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Departure" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Load weight/u })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Weather check every" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Weather source/u })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plan routes" })).toBeInTheDocument();
  });

  // R4-05: what the visitor types before the planner's code arrives is read by these marks.
  it("marks the three fields that early input is read from, one visible input in each", () => {
    const { container } = renderWithApi(
      <Harness onSubmit={vi.fn<(request: PlanRequest) => void>()} />,
      api.client,
    );

    const marked = Array.from(container.querySelectorAll("[data-early]"));
    expect(marked.map((root) => root.getAttribute("data-early"))).toEqual([
      "origin",
      "destination",
      "load",
    ]);
    for (const root of marked) {
      expect(root.querySelectorAll('input:not([type="hidden"])')).toHaveLength(1);
    }
  });

  it("offers 10, 25 and 50 miles with 25 chosen", () => {
    setup();

    const group = screen.getByRole("radiogroup", { name: "Weather check every" });
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
    for (const miles of ["10 mi", "25 mi", "50 mi"]) {
      expect(within(group).getByRole("radio", { name: miles })).toBeInTheDocument();
    }
    expect(within(group).getByRole("radio", { name: "25 mi" })).toBeChecked();
  });

  it("sends the trip a person fills in: places from the list, a preset load, the default departure", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.type(screen.getByRole("combobox", { name: /^From/u }), "salt");
    await user.click(await screen.findByRole("option", { name: /Salt Lake City/u }));
    await user.type(screen.getByRole("combobox", { name: /^To/u }), "denv");
    await user.click(await screen.findByRole("option", { name: /Denver/u }));
    await user.click(screen.getByRole("button", { name: "38,000" }));
    await user.click(screen.getByRole("button", { name: "Plan routes" }));

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      origin: SLC,
      destination: DENVER,
      departure_time: "2026-10-20T14:00:00Z",
      load_weight_lb: 38_000,
      sampling_interval_mi: 25,
      scenario: null,
    });
  });

  it("sends nothing and marks every wrong field, moving the keyboard to the first one", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(screen.getByRole("button", { name: "Plan routes" }));

    expect(onSubmit).not.toHaveBeenCalled();
    const origin = screen.getByRole("combobox", { name: /^From/u });
    expect(origin).toBeInvalid();
    expect(origin).toHaveAccessibleDescription(/Choose a starting point from the list\./u);
    expect(screen.getByRole("combobox", { name: /^To/u })).toHaveAccessibleDescription(
      /Choose a destination from the list\./u,
    );
    expect(screen.getByRole("textbox", { name: /Load weight/u })).toHaveAccessibleDescription(
      /Enter the load weight in pounds\./u,
    );
    await waitFor(() => {
      expect(origin).toHaveFocus();
    });
  });

  it("takes the keyboard to the load when it is the only wrong field", async () => {
    const user = userEvent.setup();
    setup({ defaults: { origin: SLC, destination: DENVER } });

    await user.click(screen.getByRole("button", { name: "Plan routes" }));

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /Load weight/u })).toHaveFocus();
    });
  });

  it("clears a field's error as soon as the field is edited", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Plan routes" }));

    await user.click(screen.getByRole("button", { name: "38,000" }));

    expect(screen.getByRole("textbox", { name: /Load weight/u })).toBeValid();
  });

  it("swaps the two places", async () => {
    const user = userEvent.setup();
    setup({ defaults: FILLED });

    await user.click(screen.getByRole("button", { name: "Swap origin and destination" }));

    expect(screen.getByRole("combobox", { name: /^From/u })).toHaveValue(DENVER.label);
    expect(screen.getByRole("combobox", { name: /^To/u })).toHaveValue(SLC.label);
  });

  it("remembers each place that is picked, and remembers nothing when a field is emptied", async () => {
    const user = userEvent.setup();
    setup();
    const from = screen.getByRole("combobox", { name: /^From/u });
    const to = screen.getByRole("combobox", { name: /^To/u });
    const remembered = (): unknown => JSON.parse(localStorage.getItem(RECENT_PLACES_KEY) ?? "null");

    await user.type(from, "salt");
    await user.click(await screen.findByRole("option", { name: /Salt Lake City/u }));
    await user.type(to, "denv");
    await user.click(await screen.findByRole("option", { name: /Denver/u }));
    expect(remembered()).toEqual([DENVER, SLC]);

    await user.clear(from);
    await user.clear(to);

    expect(from).toHaveValue("");
    expect(to).toHaveValue("");
    expect(remembered()).toEqual([DENVER, SLC]);
  });

  it("sends the interval that is chosen", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ defaults: FILLED });

    await user.click(screen.getByRole("radio", { name: "50 mi" }));
    await user.click(screen.getByRole("button", { name: "Plan routes" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ sampling_interval_mi: 50 }));
  });

  it("lists the live forecast and the scenarios, and sends the scenario that is chosen (R14)", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ defaults: FILLED });

    await user.click(screen.getByRole("button", { name: /Weather source/u }));
    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveTextContent("Live forecast (Open-Meteo)");
    expect(options).toHaveLength(6);
    await user.click(screen.getByRole("option", { name: /^Calm/u }));
    await user.click(screen.getByRole("button", { name: "Plan routes" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ scenario: "calm" }));
  });

  it("goes back to the live forecast when it is chosen again", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ defaults: { ...FILLED, scenario: "calm" } });

    await user.click(screen.getByRole("button", { name: /Weather source/u }));
    await user.click(await screen.findByRole("option", { name: /^Live forecast/u }));
    await user.click(screen.getByRole("button", { name: "Plan routes" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ scenario: null }));
  });

  it("says scenarios are unavailable when the list cannot be loaded, and still offers the live forecast", async () => {
    api.server.use(
      http.get("*/api/v1/scenarios", () =>
        HttpResponse.json(
          { title: "x", status: 502, code: "weather_unavailable" },
          { status: 502 },
        ),
      ),
    );
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole("button", { name: /Weather source/u }));

    expect(
      await screen.findByRole("option", { name: "Scenarios unavailable" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Live forecast/u })).toBeInTheDocument();
  });

  it("shows the plan request is running on the button and ignores a second press", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ defaults: FILLED, isSubmitting: true });

    const button = screen.getByRole("button", { name: /Planning routes/u });
    await user.click(button);

    expect(button).toHaveAttribute("aria-busy", "true");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows an error on the interval when the server rejected it", () => {
    function Rejected(): ReactElement {
      const form = usePlannerForm({}, CLOCK);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              form.showErrors({ interval: "Choose 10, 25 or 50 miles." });
            }}
          >
            reject
          </button>
          <PlannerForm form={form} clock={CLOCK} isSubmitting={false} onSubmit={() => undefined} />
        </>
      );
    }
    renderWithApi(<Rejected />, api.client);

    return userEvent
      .setup()
      .click(screen.getByRole("button", { name: "reject" }))
      .then(() => {
        expect(screen.getByText("Choose 10, 25 or 50 miles.")).toBeInTheDocument();
      });
  });
});
