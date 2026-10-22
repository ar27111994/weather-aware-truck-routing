// @vitest-environment node
import { describe, expect, it } from "vitest";

import { pageContext, pageGate } from "./page-gate";

describe("the page's gate on the server (the prerender)", () => {
  it("has no gate: there is no visitor to wait for", () => {
    expect(pageGate).toBeNull();
  });

  it("describes a page with no browser: nothing to wait for, no planner on the page, no address", () => {
    expect(pageContext()).toEqual({ gate: null, island: false, search: "" });
  });
});
