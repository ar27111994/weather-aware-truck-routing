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

  it("clips the element out of sight with the standard pattern", () => {
    render(<VisuallyHidden>Hidden words</VisuallyHidden>);

    expect(screen.getByText("Hidden words")).toHaveStyle({
      position: "absolute",
      width: "1px",
      height: "1px",
      overflow: "hidden",
    });
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

  it("stays hidden when focusable content is absent and shows itself while a child has focus", async () => {
    const user = userEvent.setup();
    render(
      <VisuallyHidden isFocusable>
        <a href="#main">Skip to main content</a>
      </VisuallyHidden>,
    );
    const link = screen.getByRole("link", { name: "Skip to main content" });

    expect(link.parentElement).toHaveStyle({ position: "absolute", width: "1px" });

    await user.tab();

    expect(link).toHaveFocus();
    expect(link.parentElement).not.toHaveStyle({ width: "1px" });
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
