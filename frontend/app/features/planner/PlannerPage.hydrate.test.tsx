import { act, screen, waitFor, within } from "@testing-library/react";
import { http } from "msw";
import type { ReactElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "react-aria";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiWrapper, startMockApi } from "../../../test/api";
import { defined } from "../../../test/defined";
import { DENVER, SLC } from "../../../test/plans";
import { t } from "../../design-system/foundation/strings";
import { createIntentGate, type IntentGate } from "./intent";
import { PlannerPage } from "./PlannerPage";
import { buildTripSearch } from "./trip-url";

// The planner as a visitor meets it (D-46, D-47): the server's page is plain HTML, the visitor uses
// it, and only then does the planner's code arrive and take the page over. Everything here is the
// real page and the real controls, hydrated over the real prerendered markup.
vi.setConfig({ testTimeout: 30_000 });

const api = startMockApi();
const TRIP = buildTripSearch({
  origin: SLC,
  destination: DENVER,
  load: 38_000,
  interval: 50,
  scenario: "calm",
});

const gates: IntentGate[] = [];

afterEach(() => {
  for (const gate of gates.splice(0)) gate.dispose();
  document.body.innerHTML = "";
});

function listen(): IntentGate {
  const gate = createIntentGate(document);
  gates.push(gate);
  return gate;
}

function page(address: string, gate: IntentGate | null): ReactElement {
  const Wrapper = apiWrapper(api.client);
  return (
    <Wrapper>
      <I18nProvider locale="en-US">
        <MemoryRouter initialEntries={[`/${address}`]}>
          <PlannerPage gate={gate} />
        </MemoryRouter>
      </I18nProvider>
    </Wrapper>
  );
}

/** The page as the server draws it: the prerendered document, with no script running in it. */
function prerender(address = ""): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  container.innerHTML = renderToString(page(address, null));
  return container;
}

/** The browser takes the page over: the planner's code has arrived. */
async function hydrate(container: HTMLElement, address: string, gate: IntentGate): Promise<void> {
  await act(async () => {
    hydrateRoot(container, page(address, gate));
    await Promise.resolve();
  });
  // What the visitor did is handed over right after the page is drawn, in a microtask of its own.
  await act(async () => {
    await Promise.resolve();
  });
}

function controls(container: HTMLElement): {
  form: HTMLFormElement;
  origin: HTMLInputElement;
  destination: HTMLInputElement;
  load: HTMLInputElement;
  interval: (value: string) => HTMLInputElement;
} {
  const places = Array.from(container.querySelectorAll<HTMLInputElement>('input[role="combobox"]'));
  return {
    form: defined(container.querySelector("form"), "the form"),
    origin: defined(places.at(0), "the origin field"),
    destination: defined(places.at(1), "the destination field"),
    load: defined(container.querySelector<HTMLInputElement>('input[inputmode="numeric"]'), "load"),
    interval: (value) =>
      defined(
        container.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`),
        `the ${value} mile choice`,
      ),
  };
}

describe("the planner takes over a prerendered page that the visitor has already used", () => {
  it("keeps what was typed and chosen meanwhile, in the very same elements", async () => {
    const gate = listen();
    const container = prerender();
    const before = controls(container);
    before.origin.value = "Salt";
    before.destination.value = "Denv";
    before.load.value = "38,000";
    before.interval("10").checked = true;

    await hydrate(container, "", gate);

    const after = controls(container);
    expect(after.form).toBe(before.form);
    expect(after.origin).toBe(before.origin);
    expect(after.destination).toBe(before.destination);
    expect(after.load).toBe(before.load);
    expect(after.origin).toHaveValue("Salt");
    expect(after.destination).toHaveValue("Denv");
    expect(after.load).toHaveValue("38,000");
    expect(after.interval("10")).toBeChecked();
    expect(after.interval("25")).not.toBeChecked();
  });

  it("fills the departure in the same form once the browser's clock is there", async () => {
    const gate = listen();
    const container = prerender();
    const form = controls(container).form;
    expect(within(container).getByRole("group", { name: "Date" })).not.toHaveTextContent(/\d/u);

    await hydrate(container, "", gate);

    expect(controls(container).form).toBe(form);
    expect(within(container).getByRole("group", { name: "Date" })).toHaveTextContent(/\d/u);
  });

  it("applies a press made before the code arrived exactly once, after the typed text is in", async () => {
    const gate = listen();
    const container = prerender();
    const before = controls(container);
    before.origin.value = "A";
    before.destination.value = "B";
    within(container)
      .getByRole("button", { name: t("form.swap") })
      .click();

    await hydrate(container, "", gate);

    await waitFor(() => {
      expect(before.origin).toHaveValue("B");
    });
    expect(before.destination).toHaveValue("A");
  });

  it("runs a submit made before the code arrived through the form's own check, once", async () => {
    const gate = listen();
    const container = prerender();
    const form = controls(container).form;
    // The prerendered form has no action: without the gate this would reload the page.
    form.requestSubmit();

    await hydrate(container, "", gate);

    expect(await screen.findAllByText(t("form.origin.error.required"))).toHaveLength(1);
  });

  it("plans a shared link's trip when the visitor submitted before the code arrived", async () => {
    const posts: unknown[] = [];
    api.server.use(
      http.post("*/api/v1/plans", async ({ request }) => {
        posts.push(await request.clone().json());
        return undefined;
      }),
    );
    const gate = listen();
    const container = prerender();
    controls(container).form.requestSubmit();

    await hydrate(container, TRIP, gate);

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    expect(posts[0]).toMatchObject({ load_weight_lb: 38_000, sampling_interval_mi: 50 });
  });

  it("hydrates a page nobody touched with nothing to hand over and nothing logged", async () => {
    const gate = listen();
    const container = prerender();
    const before = controls(container);

    await hydrate(container, "", gate);

    expect(controls(container).form).toBe(before.form);
    expect(controls(container).origin).toHaveValue("");
    expect(gate.take()).toEqual({ activations: [], submitted: false });
  });
});

// The page keeps one panel element on every screen: the sheet's look comes from the style sheet, so
// it is the same element before and after hydration, and the same whatever the screen.
describe("the planner's panel is one element", () => {
  it("is a single region, named for the planner, holding the form", async () => {
    const gate = listen();
    const container = prerender();
    const region = within(container).getByRole("region", { name: t("app.regions.planner") });
    expect(region).toContainElement(controls(container).form);
    expect(region).toHaveAttribute("data-wide", "panel");

    await hydrate(container, "", gate);

    expect(within(container).getByRole("region", { name: t("app.regions.planner") })).toBe(region);
  });
});
