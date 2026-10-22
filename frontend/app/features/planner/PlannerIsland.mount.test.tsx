import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlannerIsland } from "./PlannerIsland";
import type { PlannerBridge, PlannerMount } from "./PlannerApp";

// What the page and the planner's code promise each other, with the planner itself out of the way:
// the page hands its element and its address to the planner when the visitor reaches for it, keeps
// the planner in step with the address, and takes it down with the page. The planner's code is a
// stand-in here; `PlannerIsland.test.tsx` runs the real one.
const planner = vi.hoisted(() => ({
  mount: {
    update: vi.fn<(bridge: PlannerBridge) => void>(),
    unmount: vi.fn<() => void>(),
  },
  mountPlanner: vi.fn<(host: HTMLElement, bridge: PlannerBridge) => PlannerMount>(),
}));

vi.mock("./PlannerApp", () => ({
  default: () => null,
  mountPlanner: planner.mountPlanner,
}));

// Nobody listens for the visitor here: the planner starts as it would for a shared link.
vi.mock("./page-gate", () => ({
  pageGate: null,
  pageContext: () => ({ gate: null, island: true, search: "" }),
}));

const island = document.createElement("div");

afterEach(() => {
  island.remove();
  vi.clearAllMocks();
});

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

describe("the planner the server drew", () => {
  it("is given its element and the page's address, followed when it changes, and taken down with the page", async () => {
    island.setAttribute("data-planner-island", "");
    document.body.append(island);
    planner.mountPlanner.mockReturnValue(planner.mount);
    let navigate: NavigateFunction | undefined;

    const { container, unmount } = render(
      <MemoryRouter initialEntries={["/?origin=a"]}>
        <Navigation
          onNavigate={(next) => {
            navigate = next;
          }}
        />
        <PlannerIsland />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(planner.mountPlanner).toHaveBeenCalledTimes(1);
    });

    const call = planner.mountPlanner.mock.calls[0];
    expect(call?.[0]).toBe(container.querySelector("[data-planner-host]"));
    expect(call?.[1].location.search).toBe("?origin=a");
    expect(planner.mount.update).not.toHaveBeenCalled();

    act(() => {
      void navigate?.("/?origin=b");
    });
    expect(planner.mount.update).toHaveBeenCalledTimes(1);
    expect(planner.mount.update.mock.lastCall?.[0].location.search).toBe("?origin=b");

    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(planner.mount.unmount).toHaveBeenCalledTimes(1);
    expect(planner.mountPlanner).toHaveBeenCalledTimes(1);
  });

  it("is left as it is by a page that renders again, however often", async () => {
    island.setAttribute("data-planner-island", "");
    document.body.append(island);
    planner.mountPlanner.mockReturnValue(planner.mount);
    const tree = (
      <MemoryRouter>
        <PlannerIsland />
      </MemoryRouter>
    );
    const { container, rerender, unmount } = render(tree);
    await waitFor(() => {
      expect(planner.mountPlanner).toHaveBeenCalledTimes(1);
    });
    const host = container.querySelector("[data-planner-host]");

    rerender(tree);
    rerender(tree);

    expect(container.querySelector("[data-planner-host]")).toBe(host);
    expect(planner.mountPlanner).toHaveBeenCalledTimes(1);
    expect(planner.mount.unmount).not.toHaveBeenCalled();
    unmount();
  });
});
