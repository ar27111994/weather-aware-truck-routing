// @vitest-environment node
import { prerender } from "react-dom/static";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { PlannerIsland } from "./PlannerIsland";
import { renderPlannerMarkup } from "./planner-markup";

/** The route as the prerender draws it for an address. */
async function draw(address: string): Promise<string> {
  const { prelude } = await prerender(
    <MemoryRouter initialEntries={[address]}>
      <PlannerIsland />
    </MemoryRouter>,
  );
  return new Response(prelude).text();
}

describe("the planner on the server (the prerender)", () => {
  it("is the planner's own drawing, in an element that the page leaves alone", async () => {
    const html = await draw("/");

    expect(html).toContain('data-planner-host=""');
    expect(html).toContain(renderPlannerMarkup());
    expect(html).toContain("Haulcast route planner");
    expect(html).toContain("Plan routes");
    expect(html).toContain("data-planner-island");
  });

  // A shared link opens the prerendered page with a trip in its address. What the server drew has to
  // be the same page whatever the address says, or the page the visitor sees is not the page that
  // was drawn for them.
  it("is the same whatever the address says", async () => {
    expect(await draw("/?origin=a&plan=p_1")).toBe(await draw("/"));
  });
});

describe("the planner's own drawing", () => {
  it("has the heading, the panel and the form, with no page around it", () => {
    const html = renderPlannerMarkup();

    expect(html.startsWith("<div")).toBe(true);
    expect(html).toContain("<h1>Haulcast route planner</h1>");
    expect(html).toContain('id="planner"');
    expect(html).toContain("<form");
  });
});
