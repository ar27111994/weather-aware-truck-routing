import { describe, expect, it } from "vitest";

import { ISLAND_SELECTOR } from "./intent";
import { pageContext, pageGate } from "./page-gate";

describe("the page's gate in a browser", () => {
  it("exists, listening from the moment the page's code first runs", () => {
    expect(pageGate).not.toBeNull();
  });

  it("describes a page with no planner on it and no trip in its address", () => {
    expect(pageContext()).toEqual({ gate: pageGate, island: false, search: "" });
  });

  it("sees the prerendered planner on the page, and the trip in the address", () => {
    const island = document.createElement("div");
    island.setAttribute(ISLAND_SELECTOR.slice(1, -1), "");
    document.body.append(island);
    history.replaceState(null, "", "/?plan=plan_1");

    try {
      expect(pageContext()).toEqual({ gate: pageGate, island: true, search: "?plan=plan_1" });
    } finally {
      island.remove();
      history.replaceState(null, "", "/");
    }
  });
});
