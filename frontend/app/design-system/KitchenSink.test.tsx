import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { defined } from "../../test/defined";
import { sectionOf } from "../../test/demos";
import { renderAsync } from "../../test/render-async";
import type { DemoSection } from "./demo-registry";
import type { Demo } from "./foundation/demo";
import { t } from "./foundation/strings";
import { KitchenSink } from "./KitchenSink";

const BUTTON: Demo = {
  name: "Button",
  description: "Commit actions.",
  states: [
    { id: "primary", title: "Primary", node: <button type="button">Plan routes</button> },
    {
      id: "disabled",
      title: "Disabled",
      node: (
        <button type="button" disabled>
          Plan routes
        </button>
      ),
    },
  ],
};

const CARD: Demo = {
  name: "Card",
  description: "Raised surface.",
  states: [{ id: "default", title: "Default", node: <p>Route A</p> }],
};

const SECTIONS: readonly DemoSection[] = [sectionOf(BUTTON), sectionOf(CARD)];

/** The whole page, as `/design` shows it with no filter. */
async function renderSink(sections: readonly DemoSection[] = SECTIONS): Promise<void> {
  await renderAsync(<KitchenSink sections={sections} unknown={[]} isFiltered={false} />);
}

/**
 * The section of `name` once its demo has loaded. The placeholder that held its place is a different
 * element, so the section is looked up again on every try.
 */
async function loadedSection(name: string): Promise<HTMLElement> {
  return waitFor(() => {
    const section = screen.getByRole("region", { name });
    expect(section).toHaveAttribute("data-demo", name);
    return section;
  });
}

describe("KitchenSink", () => {
  it("has one page heading and a navigation of the components", async () => {
    await renderSink();

    expect(screen.getByRole("heading", { level: 1, name: t("design.title") })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: t("design.index") });
    expect(within(nav).getByRole("link", { name: "Button" })).toHaveAttribute(
      "href",
      "#demo-Button",
    );
    expect(within(nav).getByRole("link", { name: "Card" })).toHaveAttribute("href", "#demo-Card");
  });

  it("introduces the page in the words of the design contract", async () => {
    await renderSink();

    expect(screen.getByText(t("design.intro"))).toBeInTheDocument();
  });

  it("gives every demo a named section with its description", async () => {
    await renderSink();

    const section = await loadedSection("Button");

    expect(section).toHaveAttribute("id", "demo-Button");
    expect(within(section).getByRole("heading", { level: 2, name: "Button" })).toBeInTheDocument();
    expect(within(section).getByText("Commit actions.")).toBeInTheDocument();
  });

  it("shows every state as a figure with its caption", async () => {
    await renderSink();

    const section = await loadedSection("Button");

    const figures = within(section).getAllByRole("figure");
    expect(figures).toHaveLength(2);
    expect(defined(figures[0], "first figure")).toHaveAttribute("data-state", "primary");
    expect(within(defined(figures[0])).getByText("Primary")).toBeInTheDocument();
    expect(
      within(defined(figures[1], "second figure")).getByRole("button", { name: "Plan routes" }),
    ).toBeDisabled();
  });

  it("holds the place of a section under its name, marked busy, until its demo has loaded", async () => {
    let finish: (demo: Demo) => void = () => undefined;
    const slow = new Promise<Demo>((resolve) => {
      finish = resolve;
    });
    await renderSink([{ name: "Button", load: () => slow }]);

    const waiting = screen.getByRole("region", { name: "Button" });
    expect(waiting).toHaveAttribute("aria-busy", "true");
    expect(waiting).toHaveAttribute("id", "demo-Button");
    expect(waiting).not.toHaveAttribute("data-demo");
    expect(within(waiting).queryByRole("figure")).not.toBeInTheDocument();

    await act(async () => {
      finish(BUTTON);
      await slow;
    });

    const loaded = await loadedSection("Button");
    expect(loaded).not.toHaveAttribute("aria-busy");
    expect(within(loaded).getAllByRole("figure")).toHaveLength(2);
  });

  it("lists every component in the navigation before any demo has loaded", async () => {
    await renderSink([
      { name: "Avatar", load: () => new Promise<Demo>(() => undefined) },
      ...SECTIONS,
    ]);

    const nav = screen.getByRole("navigation", { name: t("design.index") });
    expect(within(nav).getAllByRole("link")).toHaveLength(3);
  });

  it("renders nothing but the introduction for no sections", async () => {
    await renderSink([]);

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  });

  it("offers no way back when it shows every component", async () => {
    await renderSink();

    expect(screen.queryByRole("link", { name: t("design.showAll") })).not.toBeInTheDocument();
  });

  it("offers the whole page when it shows only some of the components", async () => {
    await renderAsync(<KitchenSink sections={[sectionOf(CARD)]} unknown={[]} isFiltered />);

    expect(screen.getByRole("link", { name: t("design.showAll") })).toHaveAttribute(
      "href",
      "/design",
    );
    expect(screen.getByRole("link", { name: "Card" })).toHaveAttribute("href", "#demo-Card");
    expect(screen.queryByRole("link", { name: "Button" })).not.toBeInTheDocument();
  });

  it("says so when the name of a component that was asked for does not exist", async () => {
    await renderAsync(<KitchenSink sections={[]} unknown={["Nope"]} isFiltered />);

    expect(screen.getByText("There is no component named Nope.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("design.showAll") })).toBeInTheDocument();
  });

  it("lists the names, in the plural, when several do not exist", async () => {
    await renderAsync(<KitchenSink sections={[]} unknown={["Nope", "Nada"]} isFiltered />);

    expect(screen.getByText("There are no components named Nope, Nada.")).toBeInTheDocument();
  });
});
