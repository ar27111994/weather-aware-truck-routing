import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Skeleton } from "./Skeleton";

describe("Skeleton", () => {
  it("is hidden from assistive technology", () => {
    const { container } = render(<Skeleton />);

    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  it("is a full-width line of text by default", () => {
    const { container } = render(<Skeleton />);

    expect(container.firstElementChild).toHaveAttribute("data-width", "full");
    expect(container.firstElementChild).toHaveAttribute("data-height", "text");
    expect(container.firstElementChild).toHaveAttribute("data-shape", "rect");
  });

  it.each(["full", "three-quarters", "half", "third", "quarter"] as const)(
    "renders the %s width",
    (width) => {
      const { container } = render(<Skeleton width={width} />);

      expect(container.firstElementChild).toHaveAttribute("data-width", width);
    },
  );

  it.each(["text", "title", "bar", "block"] as const)("renders the %s height", (height) => {
    const { container } = render(<Skeleton height={height} />);

    expect(container.firstElementChild).toHaveAttribute("data-height", height);
  });

  it("can be a circle", () => {
    const { container } = render(<Skeleton shape="circle" height="block" />);

    expect(container.firstElementChild).toHaveAttribute("data-shape", "circle");
  });

  it("renders several lines with a shorter last line", () => {
    const { container } = render(<Skeleton lines={3} width="full" />);
    const lines = container.querySelectorAll("[data-width]");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toHaveAttribute("data-width", "full");
    expect(lines[1]).toHaveAttribute("data-width", "full");
    expect(lines[2]).toHaveAttribute("data-width", "half");
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  it("treats a single line as one placeholder, not a stack", () => {
    const { container } = render(<Skeleton lines={1} />);

    expect(container.querySelectorAll("[data-width]")).toHaveLength(1);
  });

  it("merges a caller class name in both forms", () => {
    const { container } = render(
      <>
        <Skeleton className="single" />
        <Skeleton lines={2} className="stack" />
      </>,
    );

    expect(container.querySelector(".single")).not.toBeNull();
    expect(container.querySelector(".stack")).not.toBeNull();
  });

  it("has no accessibility violations inside a busy region", async () => {
    const { container } = render(
      <section aria-label="Routes" aria-busy="true">
        <Skeleton height="title" width="half" />
        <Skeleton lines={3} />
        <Skeleton shape="circle" height="block" />
      </section>,
    );

    await expectNoAxeViolations(container);
  });
});
