import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Divider } from "./Divider";

describe("Divider", () => {
  it("is a horizontal separator by default", () => {
    render(<Divider />);

    const separator = screen.getByRole("separator");
    expect(separator).not.toHaveAttribute("aria-orientation");
  });

  it("can be vertical, and says so to assistive technology", () => {
    render(<Divider orientation="vertical" />);

    const separator = screen.getByRole("separator");
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
  });

  it("merges a caller class name", () => {
    render(<Divider className="custom" />);

    expect(screen.getByRole("separator")).toHaveClass("custom");
  });

  it("has no accessibility violations in either orientation", async () => {
    const { container } = render(
      <div>
        <Divider />
        <Divider orientation="vertical" />
      </div>,
    );

    await expectNoAxeViolations(container);
  });
});
