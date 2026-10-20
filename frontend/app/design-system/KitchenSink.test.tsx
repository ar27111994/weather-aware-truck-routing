import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { defined } from "../../test/defined";
import type { Demo } from "./foundation/demo";
import { KitchenSink } from "./KitchenSink";

const DEMOS: readonly Demo[] = [
  {
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
  },
  {
    name: "Card",
    description: "Raised surface.",
    states: [{ id: "default", title: "Default", node: <p>Route A</p> }],
  },
];

describe("KitchenSink", () => {
  it("has one page heading and a navigation of the components", () => {
    render(<KitchenSink demos={DEMOS} />);

    expect(screen.getByRole("heading", { level: 1, name: "Design system" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Components" });
    expect(within(nav).getByRole("link", { name: "Button" })).toHaveAttribute(
      "href",
      "#demo-Button",
    );
    expect(within(nav).getByRole("link", { name: "Card" })).toHaveAttribute("href", "#demo-Card");
  });

  it("gives every demo a named section with its description", () => {
    render(<KitchenSink demos={DEMOS} />);

    const section = screen.getByRole("region", { name: "Button" });
    expect(section).toHaveAttribute("id", "demo-Button");
    expect(section).toHaveAttribute("data-demo", "Button");
    expect(within(section).getByRole("heading", { level: 2, name: "Button" })).toBeInTheDocument();
    expect(within(section).getByText("Commit actions.")).toBeInTheDocument();
  });

  it("shows every state as a figure with its caption", () => {
    render(<KitchenSink demos={DEMOS} />);

    const section = screen.getByRole("region", { name: "Button" });
    const figures = within(section).getAllByRole("figure");
    expect(figures).toHaveLength(2);
    expect(defined(figures[0], "first figure")).toHaveAttribute("data-state", "primary");
    expect(within(defined(figures[0])).getByText("Primary")).toBeInTheDocument();
    expect(
      within(defined(figures[1], "second figure")).getByRole("button", { name: "Plan routes" }),
    ).toBeDisabled();
  });

  it("renders nothing but the introduction for no demos", () => {
    const { container } = render(<KitchenSink demos={[]} />);

    expect(container.querySelectorAll("section")).toHaveLength(0);
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  });
});
