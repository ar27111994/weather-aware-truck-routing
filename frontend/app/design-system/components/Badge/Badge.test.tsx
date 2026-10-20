import { render, screen } from "@testing-library/react";
import { Star } from "lucide-react";
import { describe, expect, it } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { RISK_LEVELS } from "../../foundation/risk";
import type { RiskLevel } from "../../foundation/risk";
import { Badge } from "./Badge";

const LABELS: Readonly<Record<RiskLevel, string>> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
  severe: "Severe",
  no_travel: "No Travel",
};

describe("Badge", () => {
  it.each(RISK_LEVELS)("shows the %s level as a word, never colour alone", (level) => {
    render(<Badge level={level} />);

    const badge = screen.getByText(LABELS[level]).closest("[data-level]");
    expect(badge).toHaveAttribute("data-level", level);
    expect(badge?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("draws a different shape for every level, Unknown included", () => {
    const shapes = new Set<string>();
    for (const level of [...RISK_LEVELS, null]) {
      const { container, unmount } = render(<Badge level={level} />);
      shapes.add(container.querySelector("svg")?.getAttribute("class") ?? "");
      unmount();
    }

    expect(shapes.size).toBe(6);
  });

  it.each([null, undefined])("treats %s as Unknown, drawn dashed and outlined", (level) => {
    render(<Badge level={level} />);

    const badge = screen.getByText("Unknown").closest("[data-level]");
    expect(badge).toHaveAttribute("data-level", "unknown");
    expect(badge).toHaveAttribute("data-variant", "outline");
  });

  it("is solid by default for a scored level", () => {
    render(<Badge level="high" />);

    expect(screen.getByText("High").closest("[data-level]")).toHaveAttribute(
      "data-variant",
      "solid",
    );
  });

  it.each(["solid", "subtle", "outline"] as const)("renders the %s variant", (variant) => {
    render(<Badge level="severe" variant={variant} />);

    expect(screen.getByText("Severe").closest("[data-level]")).toHaveAttribute(
      "data-variant",
      variant,
    );
  });

  it("honours an explicit solid variant for Unknown", () => {
    render(<Badge level={null} variant="solid" />);

    expect(screen.getByText("Unknown").closest("[data-level]")).toHaveAttribute(
      "data-variant",
      "solid",
    );
  });

  it("renders the neutral ink badge with a check mark by default", () => {
    render(<Badge variant="neutral">Recommended</Badge>);

    const badge = screen.getByText("Recommended").closest("[data-variant]");
    expect(badge).toHaveAttribute("data-variant", "neutral");
    expect(badge).not.toHaveAttribute("data-level");
    expect(badge?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("accepts another icon on the neutral badge", () => {
    const { container: withCheck } = render(<Badge variant="neutral">Recommended</Badge>);
    const { container: withStar } = render(
      <Badge variant="neutral" icon={Star}>
        Starred
      </Badge>,
    );

    expect(withStar.querySelector("svg")?.getAttribute("class")).not.toBe(
      withCheck.querySelector("svg")?.getAttribute("class"),
    );
  });

  it("is never interactive", () => {
    render(<Badge level="low" />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Low").closest("[data-level]")).not.toHaveAttribute("tabindex");
  });

  it("merges a caller class name on both kinds", () => {
    render(
      <>
        <Badge level="low" className="custom-risk" />
        <Badge variant="neutral" className="custom-neutral">
          Recommended
        </Badge>
      </>,
    );

    expect(screen.getByText("Low").closest("[data-level]")).toHaveClass("custom-risk");
    expect(screen.getByText("Recommended").closest("[data-variant]")).toHaveClass("custom-neutral");
  });

  it("has no accessibility violations for every level and variant", async () => {
    const { container } = render(
      <div>
        {[...RISK_LEVELS, null].flatMap((level) =>
          (["solid", "subtle", "outline"] as const).map((variant) => (
            <Badge key={`${String(level)}-${variant}`} level={level} variant={variant} />
          )),
        )}
        <Badge variant="neutral">Recommended</Badge>
      </div>,
    );

    await expectNoAxeViolations(container);
  });
});
