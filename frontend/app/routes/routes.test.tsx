import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DEMO_COUNT } from "../../test/demos";
import Design, { meta as designMeta } from "./design";
import Home, { meta as homeMeta } from "./home";
import Methodology, { meta as methodologyMeta } from "./methodology";
import NotFound, { meta as notFoundMeta } from "./not-found";

describe("home route", () => {
  it("renders the product name as the page heading with the planner copy under it", () => {
    render(<Home />);

    expect(screen.getByRole("heading", { level: 1, name: "Haulcast" })).toBeInTheDocument();
    expect(screen.getByText("Plan around the weather.")).toBeInTheDocument();
  });

  it("declares the site title, description, canonical-ready social tags and no noindex", () => {
    const tags = homeMeta();

    expect(tags).toContainEqual({ title: "Haulcast: weather-aware truck route planner" });
    expect(tags).toContainEqual(expect.objectContaining({ name: "description" }));
    expect(tags).toContainEqual({ property: "og:type", content: "website" });
    expect(tags).not.toContainEqual(expect.objectContaining({ name: "robots" }));
  });
});

describe("methodology route", () => {
  it("renders its title as the page heading", () => {
    render(<Methodology />);

    expect(
      screen.getByRole("heading", { level: 1, name: "How Haulcast scores weather risk" }),
    ).toBeInTheDocument();
  });

  it("declares its own title and description", () => {
    const tags = methodologyMeta();
    const description = tags.find((tag) => "name" in tag && tag.name === "description");

    expect(tags).toContainEqual({ title: "How Haulcast scores weather risk" });
    expect(description).toHaveProperty("content", expect.stringContaining("Every checkpoint"));
  });
});

describe("not-found route", () => {
  it("renders the not-found page", () => {
    render(<NotFound />);

    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
  });

  it("keeps itself out of search results", () => {
    expect(notFoundMeta()).toContainEqual({ name: "robots", content: "noindex, nofollow" });
  });
});

describe("design route (the kitchen sink)", () => {
  it("renders a section for every component demo", () => {
    const { container } = render(<Design />);

    expect(screen.getByRole("heading", { level: 1, name: "Design system" })).toBeInTheDocument();
    expect(container.querySelectorAll("section[data-demo]")).toHaveLength(DEMO_COUNT);
  });

  it("is noindex, for it is a working tool and not a page for search", () => {
    const tags = designMeta();

    expect(tags).toContainEqual({ name: "robots", content: "noindex, nofollow" });
    expect(tags).toContainEqual({ title: "Design system" });
  });
});
