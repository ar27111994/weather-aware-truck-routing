import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Home, { meta } from "./home";

describe("home route", () => {
  it("renders the product name as the page heading", () => {
    render(<Home />);

    expect(screen.getByRole("heading", { level: 1, name: "Haulcast" })).toBeInTheDocument();
  });

  it("declares a descriptive title and meta description", () => {
    expect(meta()).toEqual([
      { title: "Haulcast — Weather-aware truck routing" },
      {
        name: "description",
        content: "Pick the safest truck route from weather, load weight and travel time.",
      },
    ]);
  });
});
