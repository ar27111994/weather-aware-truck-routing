import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { at } from "../../lib/checked";
import { planFor } from "../../../test/plans";
import { TripDetails } from "./TripDetails";

const plan = planFor("mixed", { load_weight_lb: 38_000, sampling_interval_mi: 25 });
const route = at(plan.routes, 0);

describe("TripDetails", () => {
  it("lists when the truck leaves, the load, the gross weight routing used, the spacing and the checkpoint count", () => {
    render(<TripDetails plan={plan} route={route} />);

    const facts = screen.getByText("Departure").closest("dl");
    if (facts === null) throw new Error("no facts list");
    expect(within(facts).getByText("Tue 8:00 AM MDT")).toBeInTheDocument();
    expect(within(facts).getByText("38,000 lb")).toBeInTheDocument();
    expect(within(facts).getByText("73,000 lb")).toBeInTheDocument();
    expect(within(facts).getByText("25 mi")).toBeInTheDocument();
    expect(within(facts).getByText(String(route.checkpoints.length))).toBeInTheDocument();
    expect(within(facts).getByText(plan.plan_id)).toBeInTheDocument();
  });

  it("names every data source with its attribution", () => {
    render(<TripDetails plan={plan} route={route} />);

    const sources = screen.getByRole("region", { name: "Data sources" });
    for (const line of plan.sources.attribution) {
      expect(within(sources).getByText(line)).toBeInTheDocument();
    }
  });

  it("says until when the shared link works", () => {
    render(<TripDetails plan={plan} route={route} />);

    expect(
      screen.getByText(/^Shared link works until [A-Z][a-z]{2} \d{1,2}, \d{4}$/u),
    ).toBeInTheDocument();
  });
});
