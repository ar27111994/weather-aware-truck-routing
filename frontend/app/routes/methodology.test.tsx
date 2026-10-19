import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Methodology, { meta } from "./methodology";

describe("methodology route", () => {
  it("renders the methodology heading", () => {
    render(<Methodology />);

    expect(screen.getByRole("heading", { level: 1, name: "Methodology" })).toBeInTheDocument();
  });

  it("declares a descriptive title and meta description", () => {
    expect(meta()).toEqual([
      { title: "Methodology — Haulcast" },
      {
        name: "description",
        content: "How Haulcast scores weather risk along a truck route and ranks the options.",
      },
    ]);
  });
});
