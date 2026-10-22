import { act, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, type ReactElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defined } from "../../../test/defined";
import { installMatchMedia } from "../../../test/match-media";
import { CHICAGO, DENVER, SLC } from "../../../test/plans";
import { memoryThemeEnvironment } from "../../../test/theme-store";
import { DARK_QUERY } from "../../design-system/foundation/theme";
import { ThemeProvider } from "../../design-system/foundation/ThemeProvider";
import { createThemeStore, type ThemeStore } from "../../design-system/foundation/theme-store";
import { createIntentGate, type IntentGate } from "./intent";
import { renderPlannerMarkup } from "./planner-markup";
import { PlannerIsland } from "./PlannerIsland";
import styles from "./PlannerIsland.module.css";
import { buildTripSearch } from "./trip-url";

// The planner as a visitor meets it (N1, D-46, D-47): the server's drawing is plain markup, the page
// around it keeps changing, and only when the visitor reaches for it does the planner's real code
// arrive and take that markup over. The planner is the real one; only the page's listener for the
// visitor's input is the test's own, so that each test has a visitor of its own.
vi.setConfig({ testTimeout: 90_000 });

const page = vi.hoisted(() => ({ gate: null as IntentGate | null, search: "" }));

vi.mock("./page-gate", async () => {
  const { ISLAND_SELECTOR } = await import("./intent");
  return {
    pageGate: null,
    pageContext: () => ({
      gate: page.gate,
      island: document.querySelector(ISLAND_SELECTOR) !== null,
      search: page.search,
    }),
  };
});

const SLOW = { timeout: 45_000 };
const roots: Root[] = [];
let gate: IntentGate;

beforeEach(() => {
  installMatchMedia({ [DARK_QUERY]: false });
  gate = createIntentGate(document);
  page.gate = gate;
  page.search = "";
});

afterEach(() => {
  gate.dispose();
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
});

/** The page as the server drew it: the planner's own drawing in the element the page keeps for it. */
function prerendered(): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  container.innerHTML = `<div class="${styles.host}" data-planner-host="">${renderPlannerMarkup()}</div>`;
  return container;
}

function freshTheme(): ThemeStore {
  return createThemeStore(() => memoryThemeEnvironment("dark"));
}

/** Hands the page router's `navigate` to the test. */
function Navigation({
  onNavigate,
}: {
  readonly onNavigate: (navigate: NavigateFunction) => void;
}): null {
  const navigate = useNavigate();
  useEffect(() => {
    onNavigate(navigate);
  }, [navigate, onNavigate]);
  return null;
}

const ignoreNavigate = (): void => undefined;

/** The page around the planner: the theme above, the router, and the route's planner. */
function around(
  store: ThemeStore,
  address = "/",
  onNavigate: (navigate: NavigateFunction) => void = ignoreNavigate,
): ReactElement {
  return (
    <ThemeProvider store={store}>
      <MemoryRouter initialEntries={[address]}>
        <Navigation onNavigate={onNavigate} />
        <PlannerIsland />
      </MemoryRouter>
    </ThemeProvider>
  );
}

/** The browser takes the page over, as it does when it has loaded the page's own code. */
async function hydrate(container: HTMLElement, element: ReactElement): Promise<void> {
  await act(async () => {
    roots.push(hydrateRoot(container, element));
    await Promise.resolve();
  });
}

function originOf(container: HTMLElement): HTMLInputElement {
  return defined(
    container.querySelector<HTMLInputElement>('input[role="combobox"]'),
    "the origin field",
  );
}

describe("the planner the server drew", () => {
  // The bug this design exists for: a saved theme, or a theme changed in another tab, updates the
  // page around the planner. A planner that React was asked to keep until its code arrived is drawn
  // again, empty, on its second update. This one is not React's to keep.
  it("is left as it was by changes of the theme before the visitor touches it", async () => {
    const container = prerendered();
    const store = freshTheme();
    await hydrate(container, around(store));
    const form = defined(container.querySelector("form"), "the form");
    const before = container.innerHTML;

    for (const theme of ["light", "dark", "light"] as const) {
      act(() => {
        store.set(theme);
      });
    }

    expect(container.querySelector("form")).toBe(form);
    expect(container.innerHTML).toBe(before);
    expect(within(container).getByRole("heading", { level: 1 })).toHaveTextContent(
      "Haulcast route planner",
    );
  });

  it("is taken over at the visitor's first input, element for element", async () => {
    const container = prerendered();
    await hydrate(container, around(freshTheme()));
    const form = defined(container.querySelector("form"), "the form");
    const origin = originOf(container);
    expect(within(container).getByRole("group", { name: "Date" })).not.toHaveTextContent(/\d/u);

    await act(async () => {
      document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await Promise.resolve();
    });

    // Only the browser knows what time it is, so the departure has a value once the planner is alive.
    await waitFor(() => {
      expect(within(container).getByRole("group", { name: "Date" })).toHaveTextContent(/\d/u);
    }, SLOW);
    expect(container.querySelector("form")).toBe(form);
    expect(originOf(container)).toBe(origin);
  });

  it("follows the page's address once it is alive, from a shared link on", async () => {
    const link = (origin: typeof SLC): string =>
      buildTripSearch({
        origin,
        destination: DENVER,
        load: 38_000,
        interval: 50,
        scenario: "calm",
      });
    page.search = link(SLC);
    let navigate: NavigateFunction | undefined;
    const container = prerendered();

    // A shared link is a visitor who came to use the planner: it starts without waiting for an input.
    await hydrate(
      container,
      around(freshTheme(), `/${link(SLC)}`, (next) => {
        navigate = next;
      }),
    );
    await waitFor(() => {
      expect(originOf(container)).toHaveValue(SLC.label);
    }, SLOW);

    act(() => {
      void navigate?.({ search: link(CHICAGO) });
    });

    await waitFor(() => {
      expect(originOf(container)).toHaveValue(CHICAGO.label);
    }, SLOW);
  });
});

describe("the planner on a visit that arrives by navigating inside the app", () => {
  it("is drawn at once in the page's own tree, with no server's drawing to keep", async () => {
    render(around(freshTheme()));

    expect(await screen.findByRole("button", { name: "Plan routes" }, SLOW)).toBeInTheDocument();
  });
});
