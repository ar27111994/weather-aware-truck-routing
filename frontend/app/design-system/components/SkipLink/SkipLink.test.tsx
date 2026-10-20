import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { SkipLink } from "./SkipLink";

describe("SkipLink", () => {
  it("is a link to the target with the planner wording by default", () => {
    render(<SkipLink href="#planner" />);

    const link = screen.getByRole("link", { name: "Skip to trip planner" });
    expect(link).toHaveAttribute("href", "#planner");
  });

  it("takes other link text", () => {
    render(<SkipLink href="#main">Skip to main content</SkipLink>);

    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute(
      "href",
      "#main",
    );
  });

  it("is the first tab stop and takes keyboard focus", async () => {
    const user = userEvent.setup();
    render(
      <>
        <SkipLink href="#main" />
        <button type="button">Other control</button>
      </>,
    );

    await user.tab();

    expect(screen.getByRole("link", { name: "Skip to trip planner" })).toHaveFocus();
  });

  // Whether it is hidden until focus is checked in a browser (`e2e/design-system.spec.ts`, the skip
  // link test): a class name here would pass with the hiding rule deleted (R1-20).
  it("never hides itself with an inline style (strict CSP)", () => {
    render(<SkipLink href="#main" />);

    expect(screen.getByRole("link").parentElement).not.toHaveAttribute("style");
  });

  it("merges a caller class name", () => {
    render(<SkipLink href="#main" className="custom" />);

    expect(screen.getByRole("link")).toHaveClass("custom");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(
      <>
        <SkipLink href="#main" />
        <main id="main" tabIndex={-1}>
          <h1>Haulcast</h1>
        </main>
      </>,
    );

    await expectNoAxeViolations(container);
  });
});
