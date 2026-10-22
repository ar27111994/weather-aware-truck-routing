// @vitest-environment node
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { DENVER, SLC } from "../../../test/plans";
import { createQueryClient } from "../../api/queries";
import { PlannerPage } from "./PlannerPage";
import { buildTripSearch } from "./trip-url";

function page(address: string): ReactElement {
  return (
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[address]}>
        <PlannerPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("PlannerPage on the server (the prerender)", () => {
  it("draws the panel at the side with its form, and the map region, but no sheet", () => {
    const html = renderToString(page("/"));

    expect(html).toContain("Haulcast route planner");
    expect(html).toContain('<section aria-label="Trip planner"');
    expect(html).toContain('id="planner"');
    expect(html).toContain("Plan routes");
    expect(html).not.toContain("data-snap");
  });

  // A shared link opens the prerendered page with a trip in its address. The browser's first render
  // must be the prerendered markup, trip or no trip: a page that differs is thrown away (React
  // error 418) and `<html>` loses the `data-theme` the inline script gave it. The trip is read one
  // render later, once the browser has taken over.
  it("draws the same page whatever the address says, so that a shared link hydrates", () => {
    const shared = buildTripSearch({
      origin: SLC,
      destination: DENVER,
      load: 38_000,
      interval: 50,
      scenario: "calm",
    });

    expect(renderToString(page(`/${shared}`))).toBe(renderToString(page("/")));
  });
});
