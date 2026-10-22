// @vitest-environment node
import { QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { createQueryClient } from "../../api/queries";
import { PlannerPage } from "./PlannerPage";

describe("PlannerPage on the server (the prerender)", () => {
  it("draws the panel at the side with its form, and the map region, but no sheet", () => {
    const html = renderToString(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={["/"]}>
          <PlannerPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(html).toContain("Haulcast route planner");
    expect(html).toContain('<section aria-label="Trip planner"');
    expect(html).toContain('id="planner"');
    expect(html).toContain("Plan routes");
    expect(html).not.toContain("data-snap");
  });
});
