import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { planFor } from "../../../test/plans";
import { MapRegion } from "./MapRegion";

describe("MapRegion", () => {
  it("is the named map region, loading, before there is a plan", () => {
    render(<MapRegion plan={null} heatmapState="idle" />);

    const region = screen.getByRole("region", { name: "Route map" });
    expect(region).toHaveTextContent("Loading map");
    expect(region).toHaveAttribute("data-plan", "none");
    expect(region).toHaveAttribute("data-heatmap", "idle");
  });

  it("carries the plan on show and where its forecast stands, for the map that replaces it", () => {
    const plan = planFor("calm");

    render(<MapRegion plan={plan} heatmapState="loading" />);

    const region = screen.getByRole("region", { name: "Route map" });
    expect(region).toHaveAttribute("data-plan", plan.plan_id);
    expect(region).toHaveAttribute("data-heatmap", "loading");
  });
});
