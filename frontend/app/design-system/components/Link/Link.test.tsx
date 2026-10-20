import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Link } from "./Link";

describe("Link", () => {
  it("renders an anchor with its href and text", () => {
    render(<Link href="/methodology">Methodology</Link>);

    const link = screen.getByRole("link", { name: "Methodology" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/methodology");
    expect(link).toHaveAttribute("data-variant", "inline");
  });

  it("does not open a new tab or add a cue for an internal link", () => {
    render(<Link href="/methodology">Methodology</Link>);

    const link = screen.getByRole("link");
    expect(link).not.toHaveAttribute("target");
    expect(link).not.toHaveAttribute("rel");
    expect(link.querySelector("svg")).toBeNull();
  });

  it("opens an external link safely and says so to screen readers", () => {
    render(
      <Link href="https://open-meteo.com" isExternal>
        Open-Meteo
      </Link>,
    );

    const link = screen.getByRole("link", { name: "Open-Meteo (opens in new tab)" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    const cue = link.querySelector("svg");
    expect(cue).toHaveAttribute("aria-hidden", "true");
    expect(cue).toHaveAttribute("width", "12");
  });

  it("marks the current page on a navigation link", () => {
    render(
      <nav aria-label="Primary">
        <Link href="/" variant="nav" aria-current="page">
          Planner
        </Link>
        <Link href="/methodology" variant="nav">
          Methodology
        </Link>
      </nav>,
    );

    const current = screen.getByRole("link", { name: "Planner" });
    expect(current).toHaveAttribute("data-variant", "nav");
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current).toHaveAttribute("data-current", "true");
    expect(screen.getByRole("link", { name: "Methodology" })).not.toHaveAttribute("data-current");
  });

  it("fires onPress for a click and for Enter", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(
      <Link href="#top" onPress={onPress}>
        Back to top
      </Link>,
    );
    const link = screen.getByRole("link", { name: "Back to top" });

    await user.click(link);
    expect(onPress).toHaveBeenCalledTimes(1);

    link.focus();
    await user.keyboard("{Enter}");
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("shows hover and keyboard focus through data attributes", async () => {
    const user = userEvent.setup();
    render(<Link href="#a">Anchor</Link>);
    const link = screen.getByRole("link", { name: "Anchor" });

    await user.hover(link);
    expect(link).toHaveAttribute("data-hovered", "true");

    await user.tab();
    expect(link).toHaveFocus();
    expect(link).toHaveAttribute("data-focus-visible", "true");
  });

  it("merges a caller class name", () => {
    render(
      <Link href="#a" className="custom">
        Anchor
      </Link>,
    );

    expect(screen.getByRole("link")).toHaveClass("custom");
  });

  it("has no accessibility violations in any variant", async () => {
    const { container } = render(
      <div>
        <Link href="#a">Inline</Link>
        <Link href="https://example.com" isExternal>
          External
        </Link>
        <nav aria-label="Primary">
          <Link href="#b" variant="nav" aria-current="page">
            Nav
          </Link>
        </nav>
      </div>,
    );

    await expectNoAxeViolations(container);
  });
});
