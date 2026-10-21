import { render, screen, waitFor, within } from "@testing-library/react";
import { isValidElement } from "react";
import { createRoutesStub, type MetaDescriptor } from "react-router";
import { describe, expect, it } from "vitest";

import { renderAsync } from "../../test/render-async";
import { t } from "../design-system/foundation/strings";
import { MethodologyPage } from "../features/methodology/MethodologyPage";
import { PlannerPage } from "../features/planner/PlannerPage";
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
    expect(page.type).toBe(PlannerPage);
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
  /** `/design` at an address, rendered the way the router renders it. */
  async function renderDesign(address: string): Promise<void> {
    const Stub = createRoutesStub([{ path: "/design", Component: Design }]);
    await renderAsync(<Stub initialEntries={[address]} />);
  }

  // Rendering the whole page mounts every demo of every component: 0.9 s on a quiet machine and
  // 4 s on a busy one (R1-43). That is not this route's job, so these tests ask for one or two
  // sections. `selectSections` is tested on its own in `demo-registry.test.tsx`, and
  // `KitchenSink.test.tsx` renders the sink.
  it("shows the sections that the address asks for, and only those", async () => {
    await renderDesign("/design?section=Card&section=Button");

    const nav = screen.getByRole("navigation", { name: t("design.index") });
    expect(within(nav).getAllByRole("link")).toHaveLength(2);
    await waitFor(() => {
      expect(document.querySelectorAll("section[data-demo]")).toHaveLength(2);
    });
    expect(screen.getByRole("region", { name: "Button" })).toHaveAttribute("data-demo", "Button");
    expect(screen.getByRole("region", { name: "Card" })).toHaveAttribute("data-demo", "Card");
    expect(screen.queryByRole("region", { name: "Badge" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("design.showAll") })).toBeInTheDocument();
  });

  // The only test that loads every section (a whole page costs 1 s on a quiet machine, 4 s on a busy
  // one): it runs each loader once, which shows that the route's list of sections is the list of
  // demo files and that none of them fails to load.
  it(
    "lists and loads every section when the address asks for none",
    { timeout: 30_000 },
    async () => {
      const demoCount = Object.keys(
        import.meta.glob("../design-system/components/*/*.demo.tsx"),
      ).length;

      await renderDesign("/design");

      const nav = screen.getByRole("navigation", { name: t("design.index") });
      expect(within(nav).getAllByRole("link")).toHaveLength(demoCount);
      await waitFor(
        () => {
          expect(document.querySelectorAll("section[data-demo]")).toHaveLength(demoCount);
        },
        { timeout: 20_000 },
      );
      expect(screen.queryByRole("link", { name: t("design.showAll") })).not.toBeInTheDocument();
    },
  );

  it("names a component that does not exist", async () => {
    await renderDesign("/design?section=Nope");

    expect(screen.getByText("There is no component named Nope.")).toBeInTheDocument();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("is noindex, for it is a working tool and not a page for search", () => {
    const tags = designMeta();

    expect(tags).toContainEqual({ name: "robots", content: "noindex, nofollow" });
    expect(tags).toContainEqual({ title: t("design.title") });
    expect(tags).toContainEqual({ name: "description", content: t("design.description") });
  });
});
