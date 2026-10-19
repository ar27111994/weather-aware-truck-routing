import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Spinner } from "./Spinner";

describe("Spinner", () => {
  it("is an indeterminate progress bar named by its label", () => {
    render(<Spinner label="Searching" />);

    const bar = screen.getByRole("progressbar", { name: "Searching" });
    expect(bar).not.toHaveAttribute("aria-valuenow");
  });

  it("keeps the label out of sight unless asked to show it", () => {
    render(<Spinner label="Searching" />);

    expect(screen.queryByText("Searching")).not.toBeInTheDocument();
  });

  it("prints the label next to the icon when asked, without announcing it twice", () => {
    render(<Spinner label="Searching" showLabel />);

    const text = screen.getByText("Searching");
    expect(text).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("progressbar", { name: "Searching" })).toBeInTheDocument();
  });

  it("draws the loader icon at 16 px by default and 20 px on request", () => {
    const { container, rerender } = render(<Spinner label="Loading" />);
    expect(container.querySelector("svg")).toHaveAttribute("width", "16");

    rerender(<Spinner label="Loading" size={20} />);
    expect(container.querySelector("svg")).toHaveAttribute("width", "20");
  });

  it("merges a caller class name", () => {
    render(<Spinner label="Loading" className="custom" />);

    expect(screen.getByRole("progressbar")).toHaveClass("custom");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(
      <div>
        <Spinner label="Searching" />
        <Spinner label="Planning routes" showLabel />
      </div>,
    );

    await expectNoAxeViolations(container);
  });
});
