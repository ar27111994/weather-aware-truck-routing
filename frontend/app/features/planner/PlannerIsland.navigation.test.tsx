import { act, render, screen, waitFor } from "@testing-library/react";
import { startTransition, Suspense, useState, type ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { allowConsole } from "../../../test/console-guard";
import { ShowsError } from "../../../test/shows-error";
import type { PlannerBridge, PlannerMount } from "./PlannerApp";
import { PlannerIsland } from "./PlannerIsland";

// R4-01 (D-46 3.1): a visit that arrives by navigating inside the app shows the planner as the
// prerender drew it, at once, and never an empty page while the planner's code is on the way. The
// router moves between pages in a transition: it keeps the old page until the new one can be drawn.
// The planner's code and the read of the prerendered page are stand-ins that each test settles
// when it wants to; `planner-shell.test.ts` tests the read, and `PlannerIsland.test.tsx` runs the
// real planner.
const standIn = vi.hoisted(() => {
  const deferred = <T,>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: Error) => void;
  } => {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  };
  return {
    deferred,
    code: deferred<undefined>(),
    shell: deferred<string>(),
    mount: {
      update: vi.fn<(bridge: PlannerBridge) => void>(),
      unmount: vi.fn<() => void>(),
    },
    mountPlanner: vi.fn<(host: HTMLElement, bridge: PlannerBridge) => PlannerMount>(),
  };
});

vi.mock("./PlannerApp", async () => {
  await standIn.code.promise;
  return { default: () => null, mountPlanner: standIn.mountPlanner };
});

vi.mock("./planner-shell", () => ({ plannerShell: () => standIn.shell.promise }));

// Nobody has given the page an input: the visitor's listener never settles. The planner must not
// wait for it, because arriving by navigation is the input.
vi.mock("./page-gate", () => ({
  pageGate: null,
  pageContext: () => ({
    gate: { intent: new Promise<void>(() => undefined) },
    island: document.querySelector("[data-planner-island]") !== null,
    search: "",
  }),
}));

/** The planner as the prerender drew it, reduced to what these tests look at. */
const DRAWING =
  '<div data-planner-island=""><h1>Haulcast route planner</h1><div data-planner-panel=""><form><input role="combobox" aria-label="From"></form></div></div>';

/** The page the visitor is on, and the link to the planner: the router's transition, in short. */
function Visit(): ReactElement {
  const [onPlanner, setOnPlanner] = useState(false);
  return (
    <MemoryRouter>
      <Suspense fallback={<p>A fallback is showing.</p>}>
        {onPlanner ? (
          <PlannerIsland />
        ) : (
          <button
            type="button"
            onClick={() => {
              startTransition(() => {
                setOnPlanner(true);
              });
            }}
          >
            Go to the planner
          </button>
        )}
      </Suspense>
    </MemoryRouter>
  );
}

/** Follows the link, as a click does, and waits for React to settle what it can. */
async function followTheLink(): Promise<void> {
  await act(async () => {
    screen.getByRole("button", { name: "Go to the planner" }).click();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.clearAllMocks();
  standIn.code = standIn.deferred<undefined>();
  standIn.shell = standIn.deferred<string>();
});

describe("the planner on a visit that arrives by navigating inside the app", () => {
  it("keeps the old page until the shell is read, then shows it before the planner's code arrives", async () => {
    const { container } = render(<Visit />);

    await followTheLink();

    // The planner's page is on the way: the old page stays, and no fallback takes its place.
    expect(screen.getByRole("button", { name: "Go to the planner" })).toBeInTheDocument();
    expect(screen.queryByText("A fallback is showing.")).not.toBeInTheDocument();

    await act(async () => {
      standIn.shell.resolve(DRAWING);
      await Promise.resolve();
    });

    // The shell is the prerender's drawing: the heading, the panel and the form, with the code still
    // on the way.
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      "Haulcast route planner",
    );
    expect(container.querySelector("[data-planner-panel] form")).not.toBeNull();
    expect(screen.queryByText("A fallback is showing.")).not.toBeInTheDocument();
    expect(standIn.mountPlanner).not.toHaveBeenCalled();

    // The code arrives and takes the shell over, element for element.
    const island = container.querySelector("[data-planner-island]");
    standIn.mountPlanner.mockReturnValue(standIn.mount);
    await act(async () => {
      standIn.code.resolve(undefined);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(standIn.mountPlanner).toHaveBeenCalledTimes(1);
    });
    const host = container.querySelector("[data-planner-host]");
    expect(standIn.mountPlanner.mock.calls[0]?.[0]).toBe(host);
    expect(host?.firstElementChild).toBe(island);
  });

  it("starts the planner's code at once, without waiting for an input", async () => {
    standIn.shell.resolve(DRAWING);
    standIn.code.resolve(undefined);
    standIn.mountPlanner.mockReturnValue(standIn.mount);
    render(<Visit />);

    await followTheLink();

    await waitFor(() => {
      expect(standIn.mountPlanner).toHaveBeenCalledTimes(1);
    });
  });

  it("gives the planner an empty element where the page has no drawing of it", async () => {
    standIn.shell.resolve("");
    standIn.code.resolve(undefined);
    standIn.mountPlanner.mockReturnValue(standIn.mount);
    const { container } = render(<Visit />);

    await followTheLink();

    await waitFor(() => {
      expect(standIn.mountPlanner).toHaveBeenCalledTimes(1);
    });
    const host = container.querySelector("[data-planner-host]");
    expect(standIn.mountPlanner.mock.calls[0]?.[0]).toBe(host);
    expect(host?.childElementCount).toBe(0);
  });

  it("shows the route's error when the planner's page cannot be read", async () => {
    // React names the component the error passed through on its way to the boundary.
    allowConsole(/did not load/u);
    allowConsole(/An error occurred in the/u);
    render(
      <ShowsError>
        <Visit />
      </ShowsError>,
    );
    await followTheLink();

    await act(async () => {
      standIn.shell.reject(new Error("The planner's page did not load."));
      await Promise.resolve();
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("The planner's page did not load.");
  });
});
