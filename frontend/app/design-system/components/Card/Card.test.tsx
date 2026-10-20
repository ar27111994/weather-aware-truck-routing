import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Card } from "./Card";

describe("Card", () => {
  it("renders its content in a div by default, unselected", () => {
    render(<Card>Route A</Card>);

    const card = screen.getByText("Route A");
    expect(card.tagName).toBe("DIV");
    expect(card).not.toHaveAttribute("data-selected");
  });

  it.each(["article", "section"] as const)("can render a named %s", (as) => {
    render(
      <Card as={as} aria-label="Route B">
        Route B details
      </Card>,
    );

    const card = screen.getByLabelText("Route B");
    expect(card.tagName).toBe(as.toUpperCase());
  });

  it("can be a list item", () => {
    render(
      <ul>
        <Card as="li">First</Card>
      </ul>,
    );

    expect(screen.getByRole("listitem")).toHaveTextContent("First");
  });

  it("marks the selected card for styling and tests", () => {
    render(<Card isSelected>Route C</Card>);

    expect(screen.getByText("Route C")).toHaveAttribute("data-selected", "true");
  });

  it("passes ids, data attributes and handlers through", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Card id="route-a" data-testid="card" data-route="a" onClick={onClick}>
        Route A
      </Card>,
    );
    const card = screen.getByTestId("card");

    await user.click(card);

    expect(card).toHaveAttribute("id", "route-a");
    expect(card).toHaveAttribute("data-route", "a");
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("merges a caller class name", () => {
    render(<Card className="custom">Route A</Card>);

    expect(screen.getByText("Route A")).toHaveClass("custom");
  });

  it("has no accessibility violations plain, selected or as a named region", async () => {
    const { container } = render(
      <div>
        <Card>Plain</Card>
        <Card isSelected>Selected</Card>
        <Card as="section" aria-label="Summary">
          Named
        </Card>
      </div>,
    );

    await expectNoAxeViolations(container);
  });
});
