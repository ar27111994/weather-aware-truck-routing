import { render, screen } from "@testing-library/react";
import { Truck } from "lucide-react";
import { describe, expect, it } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Icon } from "./Icon";

describe("Icon", () => {
  it("renders a decorative icon hidden from assistive technology by default", () => {
    const { container } = render(<Icon icon={Truck} />);
    const svg = container.querySelector("svg");

    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).not.toHaveAttribute("role");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("exposes a labelled icon as an image with that name", () => {
    render(<Icon icon={Truck} label="Truck" />);

    const image = screen.getByRole("img", { name: "Truck" });
    expect(image).not.toHaveAttribute("aria-hidden");
  });

  it("defaults to 20 px and always uses the system stroke width", () => {
    const { container } = render(<Icon icon={Truck} />);
    const svg = container.querySelector("svg");

    expect(svg).toHaveAttribute("width", "20");
    expect(svg).toHaveAttribute("height", "20");
    expect(svg).toHaveAttribute("stroke-width", "2");
  });

  it.each([16, 20, 24] as const)("renders at %i px", (size) => {
    const { container } = render(<Icon icon={Truck} size={size} />);

    expect(container.querySelector("svg")).toHaveAttribute("width", String(size));
  });

  it("merges a caller class name with its own", () => {
    const { container } = render(<Icon icon={Truck} className="custom" />);

    expect(container.querySelector("svg")).toHaveClass("custom");
  });

  it("has no accessibility violations, decorative or labelled", async () => {
    const { container } = render(
      <div>
        <Icon icon={Truck} />
        <Icon icon={Truck} label="Truck" />
      </div>,
    );

    await expectNoAxeViolations(container);
  });
});
