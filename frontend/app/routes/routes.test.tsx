import { render, screen } from "@testing-library/react";
import { isValidElement } from "react";
import type { MetaDescriptor } from "react-router";
import { describe, expect, it } from "vitest";

import { DEMO_COUNT, DEMO_MODULES } from "../../test/demos";
import { collectDemos } from "../design-system/demo-registry";
import type { Demo } from "../design-system/foundation/demo";
import { t } from "../design-system/foundation/strings";
import { KitchenSink } from "../design-system/KitchenSink";
import { MethodologyPage } from "../features/methodology/MethodologyPage";
import { PlannerIsland } from "../features/planner/PlannerIsland";
import Design, { meta as designMeta } from "./design";
import Home, { handle as homeHandle, meta as homeMeta } from "./home";
import Methodology, { meta as methodologyMeta } from "./methodology";
import NotFound, { meta as notFoundMeta } from "./not-found";

/** The `@type` of every JSON-LD block a route puts in its head. */
function ldTypes(tags: readonly MetaDescriptor[]): string[] {
  return tags.flatMap((tag) => {
    if (!("script:ld+json" in tag)) return [];
    const data = tag["script:ld+json"];
    return typeof data === "object" && data !== null && "@type" in data
      ? [String(data["@type"])]
      : [];
  });
}

describe("home route", () => {
  it("is the planner page", () => {
    const page = Home();

    if (!isValidElement(page)) {
      throw new Error("The home route must return an element.");
    }
    expect(page.type).toBe(PlannerIsland);
  });

  it("sends the skip link to the planner and leaves the footer to the panel", () => {
    expect(homeHandle).toEqual({
      skipLink: { href: "#planner", label: "app.skipLink" },
      footer: false,
    });
  });

  it("declares the site title, description, canonical-ready social tags and no noindex", () => {
    const tags = homeMeta();

    expect(tags).toContainEqual({ title: "Haulcast: weather-aware truck route planner" });
    expect(tags).toContainEqual(expect.objectContaining({ name: "description" }));
    expect(tags).toContainEqual({ property: "og:type", content: "website" });
    expect(tags).not.toContainEqual(expect.objectContaining({ name: "robots" }));
  });

  it("carries the app as structured data", () => {
    expect(ldTypes(homeMeta())).toEqual(["WebApplication"]);
  });
});

describe("methodology route", () => {
  it("is the methodology page", () => {
    const page = Methodology();

    if (!isValidElement(page)) {
      throw new Error("The methodology route must return an element.");
    }
    expect(page.type).toBe(MethodologyPage);
  });

  it("declares its own title and description", () => {
    const tags = methodologyMeta();
    const description = tags.find((tag) => "name" in tag && tag.name === "description");

    expect(tags).toContainEqual({ title: "How Haulcast scores weather risk" });
    expect(description).toHaveProperty("content", expect.stringContaining("Every checkpoint"));
  });

  it("carries the article and the questions as structured data", () => {
    expect(ldTypes(methodologyMeta())).toEqual(["TechArticle", "FAQPage"]);
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
  it("hands every component demo to the kitchen sink", () => {
    // Rendering the whole page mounts every demo of every component: 0.9 s on a quiet machine and
    // 4 s on a busy one (R1-43). That is not this route's job. It finds the demos and passes them
    // on; `KitchenSink.test.tsx` renders the sink, and `demo-registry.test.tsx` mounts each demo
    // on its own, with axe.
    const page = Design();

    if (!isValidElement<{ readonly demos: readonly Demo[] }>(page)) {
      throw new Error("The design route must return an element.");
    }
    expect(page.type).toBe(KitchenSink);
    expect(page.props.demos).toHaveLength(DEMO_COUNT);
    expect(page.props.demos.map((demo) => demo.name)).toEqual(
      collectDemos(DEMO_MODULES).map((demo) => demo.name),
    );
  });

  it("is noindex, for it is a working tool and not a page for search", () => {
    const tags = designMeta();

    expect(tags).toContainEqual({ name: "robots", content: "noindex, nofollow" });
    expect(tags).toContainEqual({ title: t("design.title") });
    expect(tags).toContainEqual({ name: "description", content: t("design.description") });
  });
});
