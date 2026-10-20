import { render, screen } from "@testing-library/react";
import { ArrowLeft } from "lucide-react";
import { describe, expect, it } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Icon } from "../Icon";
import { VisuallyHidden } from "../VisuallyHidden";
import { Kbd } from "./Kbd";

describe("Kbd", () => {
  it("renders a kbd element with the key text", () => {
    render(<Kbd>PgUp</Kbd>);

    const key = screen.getByText("PgUp");
    expect(key.tagName).toBe("KBD");
  });

  it("holds an icon with hidden words for keys the font cannot draw", () => {
    render(
      <Kbd>
        <Icon icon={ArrowLeft} size={14} />
        <VisuallyHidden>left arrow</VisuallyHidden>
      </Kbd>,
    );

    const key = screen.getByText("left arrow").closest("kbd");
    expect(key).toHaveTextContent("left arrow");
    // The arrow is a picture, not a word: assistive technology reads the hidden words instead.
    expect(key?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("merges a caller class name", () => {
    render(<Kbd className="custom">Home</Kbd>);

    expect(screen.getByText("Home")).toHaveClass("custom");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(
      <p>
        Press <Kbd>End</Kbd> to jump to the last hour.
      </p>,
    );

    await expectNoAxeViolations(container);
  });
});
