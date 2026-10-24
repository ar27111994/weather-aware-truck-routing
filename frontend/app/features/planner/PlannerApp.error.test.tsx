import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installMatchMedia } from "../../../test/match-media";
import { DARK_QUERY } from "../../design-system/foundation/theme";
import { mountPlanner, type PlannerBridge, type PlannerMount } from "./PlannerApp";
import { navigatorFor } from "./planner-bridge";

// R4-03: the planner is a React root of its own, so the route's error boundary cannot see inside
// it. An error that nothing in the planner catches ends the planner's root, and the page must be
// told, or the visitor is left with a blank panel and no way out. The planner's page is a stand-in
// that breaks. While an act scope is open React hands an uncaught error to the test instead of to
// the root's handler, so the planner is mounted outside of one, as it is in a browser.
vi.mock("./PlannerPage", () => ({
  PlannerPage: (): never => {
    throw new Error("A result broke the page.");
  },
}));

const bridge: PlannerBridge = {
  location: { pathname: "/", search: "", hash: "", state: null, key: "default" },
  navigator: navigatorFor(vi.fn()),
};

const hosts: HTMLElement[] = [];
let mounted: PlannerMount | null = null;

afterEach(() => {
  act(() => {
    mounted?.unmount();
  });
  mounted = null;
  for (const host of hosts.splice(0)) host.remove();
});

function hostWith(markup: string): HTMLElement {
  installMatchMedia({ [DARK_QUERY]: false });
  const host = document.createElement("div");
  host.innerHTML = markup;
  document.body.append(host);
  hosts.push(host);
  return host;
}

describe("mountPlanner, when something in the planner breaks", () => {
  it("tells the page, once, with the error, where the planner draws itself", async () => {
    const onFailure = vi.fn<(error: unknown) => void>();
    const host = hostWith("");

    mounted = mountPlanner(host, bridge, onFailure);

    await waitFor(() => {
      expect(onFailure).toHaveBeenCalledTimes(1);
    });
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ message: "A result broke the page." });
  });

  it("tells the page where the planner took the server's drawing over", async () => {
    const onFailure = vi.fn<(error: unknown) => void>();
    const host = hostWith("<div></div>");

    mounted = mountPlanner(host, bridge, onFailure);

    await waitFor(() => {
      expect(onFailure).toHaveBeenCalledTimes(1);
    });
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ message: "A result broke the page." });
  });
});
