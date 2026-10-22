import { act, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defined } from "../../../test/defined";
import { installMatchMedia } from "../../../test/match-media";
import { CHICAGO, DENVER, SLC } from "../../../test/plans";
import { DARK_QUERY } from "../../design-system/foundation/theme";
import { mountPlanner, type PlannerBridge, type PlannerMount } from "./PlannerApp";
import { navigatorFor } from "./planner-bridge";
import { renderPlannerMarkup } from "./planner-markup";
import { buildTripSearch } from "./trip-url";

// The planner's code in the page that holds it: it takes the server's drawing over where there is
// one, draws itself where there is not, follows the page's address, and goes when it is told to.
vi.setConfig({ testTimeout: 90_000 });

const SLOW = { timeout: 45_000 };

function bridgeAt(search: string): PlannerBridge {
  return {
    location: { pathname: "/", search, hash: "", state: null, key: "default" },
    navigator: navigatorFor(vi.fn()),
  };
}

let host: HTMLElement;
let mounted: PlannerMount | null = null;

beforeEach(() => {
  installMatchMedia({ [DARK_QUERY]: false });
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => {
    mounted?.unmount();
  });
  mounted = null;
  host.remove();
});

describe("mountPlanner", () => {
  it("takes the server's drawing over, keeps its elements, follows the address, and unmounts", async () => {
    host.innerHTML = renderPlannerMarkup();
    const form = defined(host.querySelector("form"), "the form");

    await act(async () => {
      mounted = mountPlanner(host, bridgeAt(""));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(within(host).getByRole("group", { name: "Date" })).toHaveTextContent(/\d/u);
    }, SLOW);
    expect(host.querySelector("form")).toBe(form);

    const trip = buildTripSearch({
      origin: SLC,
      destination: DENVER,
      load: 38_000,
      interval: 50,
      scenario: "calm",
    });
    act(() => {
      mounted?.update(bridgeAt(trip));
    });
    await waitFor(() => {
      expect(within(host).getAllByRole("combobox").at(0)).toHaveValue(SLC.label);
    }, SLOW);
    act(() => {
      mounted?.update(
        bridgeAt(
          buildTripSearch({
            origin: CHICAGO,
            destination: DENVER,
            load: 38_000,
            interval: 50,
            scenario: "calm",
          }),
        ),
      );
    });
    await waitFor(() => {
      expect(within(host).getAllByRole("combobox").at(0)).toHaveValue(CHICAGO.label);
    }, SLOW);

    act(() => {
      mounted?.unmount();
    });
    mounted = null;
    expect(host).toBeEmptyDOMElement();
  });

  it("draws the planner into an element that the server drew nothing in", async () => {
    await act(async () => {
      mounted = mountPlanner(host, bridgeAt(""));
      await Promise.resolve();
    });

    expect(
      await within(host).findByRole("button", { name: "Plan routes" }, SLOW),
    ).toBeInTheDocument();
  });
});
