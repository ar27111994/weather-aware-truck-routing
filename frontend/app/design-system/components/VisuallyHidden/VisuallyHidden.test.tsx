import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { VisuallyHidden } from "./VisuallyHidden";

describe("VisuallyHidden", () => {
  it("keeps the text in the accessibility tree", () => {
    render(
      <button type="button">
        <VisuallyHidden>Copy link</VisuallyHidden>
      </button>,
    );

    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it("hides through a class and never through an inline style (strict CSP)", () => {
    render(<VisuallyHidden>Hidden words</VisuallyHidden>);
    const element = screen.getByText("Hidden words");

    expect(element.className).toMatch(/hidden/);
    expect(element.className).not.toMatch(/focusable/);
    expect(element).not.toHaveAttribute("style");
  });

  it("renders a span by default and a div on request", () => {
    render(
      <>
        <VisuallyHidden>inline</VisuallyHidden>
        <VisuallyHidden elementType="div">block</VisuallyHidden>
      </>,
    );

    expect(screen.getByText("inline").tagName).toBe("SPAN");
    expect(screen.getByText("block").tagName).toBe("DIV");
  });

  it("marks a focusable instance so it can show itself while a child has focus", async () => {
    const user = userEvent.setup();
    render(
      <VisuallyHidden isFocusable>
        <a href="#main">Skip to main content</a>
      </VisuallyHidden>,
    );
    const link = screen.getByRole("link", { name: "Skip to main content" });

    expect(link.parentElement?.className).toMatch(/focusable/);
    expect(link.parentElement).not.toHaveAttribute("style");

    await user.tab();

    expect(link).toHaveFocus();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(
      <button type="button">
        <VisuallyHidden>Close</VisuallyHidden>
      </button>,
    );

    await expectNoAxeViolations(container);
  });
});
