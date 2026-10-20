import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Grid, Inline, Stack } from "./Layout";

describe("Stack", () => {
  it("stacks children with a 16 px gap, stretched, by default", () => {
    render(<Stack data-testid="stack">content</Stack>);

    const stack = screen.getByTestId("stack");
    expect(stack).toHaveAttribute("data-gap", "4");
    expect(stack).toHaveAttribute("data-align", "stretch");
    expect(stack.tagName).toBe("DIV");
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20] as const)("accepts gap key %i", (gap) => {
    render(<Stack data-testid="stack" gap={gap} />);

    expect(screen.getByTestId("stack")).toHaveAttribute("data-gap", String(gap));
  });

  it.each(["start", "center", "end", "stretch"] as const)("aligns %s", (align) => {
    render(<Stack data-testid="stack" align={align} />);

    expect(screen.getByTestId("stack")).toHaveAttribute("data-align", align);
  });

  it("renders the requested element and merges a class name", () => {
    render(
      <Stack as="ul" className="custom" aria-label="Routes">
        <li>Route A</li>
      </Stack>,
    );

    const list = screen.getByRole("list", { name: "Routes" });
    expect(list.tagName).toBe("UL");
    expect(list).toHaveClass("custom");
  });
});

describe("Inline", () => {
  it("lays children in a row, centred and unwrapped, by default", () => {
    render(<Inline data-testid="inline">content</Inline>);

    const inline = screen.getByTestId("inline");
    expect(inline).toHaveAttribute("data-gap", "2");
    expect(inline).toHaveAttribute("data-align", "center");
    expect(inline).toHaveAttribute("data-justify", "start");
    expect(inline).not.toHaveAttribute("data-wrap");
  });

  it("wraps, aligns and distributes on request", () => {
    render(<Inline data-testid="inline" wrap align="baseline" justify="between" gap={6} />);

    const inline = screen.getByTestId("inline");
    expect(inline).toHaveAttribute("data-wrap", "true");
    expect(inline).toHaveAttribute("data-align", "baseline");
    expect(inline).toHaveAttribute("data-justify", "between");
    expect(inline).toHaveAttribute("data-gap", "6");
  });

  it.each(["start", "center", "end", "stretch"] as const)("aligns %s", (align) => {
    render(<Inline data-testid="inline" align={align} />);

    expect(screen.getByTestId("inline")).toHaveAttribute("data-align", align);
  });

  it.each(["start", "center", "end", "between"] as const)("justifies %s", (justify) => {
    render(<Inline data-testid="inline" justify={justify} />);

    expect(screen.getByTestId("inline")).toHaveAttribute("data-justify", justify);
  });

  it("renders the requested element and merges a class name", () => {
    render(
      <Inline as="nav" className="custom" aria-label="Primary">
        content
      </Inline>,
    );

    expect(screen.getByRole("navigation", { name: "Primary" })).toHaveClass("custom");
  });
});

describe("Grid", () => {
  it("auto-fills columns of at least 220 px by default", () => {
    render(<Grid data-testid="grid">content</Grid>);

    const grid = screen.getByTestId("grid");
    expect(grid).toHaveAttribute("data-columns", "auto");
    expect(grid).toHaveAttribute("data-gap", "4");
  });

  it.each([1, 2, 3, 4, 5, 6] as const)("renders %i fixed columns", (columns) => {
    render(<Grid data-testid="grid" columns={columns} gap={3} />);

    const grid = screen.getByTestId("grid");
    expect(grid).toHaveAttribute("data-columns", String(columns));
    expect(grid).toHaveAttribute("data-gap", "3");
  });

  it("renders the requested element and merges a class name", () => {
    render(
      <Grid as="section" className="custom" aria-label="Stats">
        content
      </Grid>,
    );

    expect(screen.getByRole("region", { name: "Stats" })).toHaveClass("custom");
  });
});

describe("layout primitives", () => {
  it("never write an inline style (strict CSP in the prerendered HTML)", () => {
    const { container } = render(
      <Stack gap={6}>
        <Inline wrap gap={3}>
          <span>a</span>
        </Inline>
        <Grid columns={3}>
          <span>b</span>
        </Grid>
      </Stack>,
    );

    expect(container.querySelectorAll("[style]")).toHaveLength(0);
  });

  it("have no accessibility violations when nested", async () => {
    const { container } = render(
      <Stack>
        <Inline>
          <span>Row</span>
        </Inline>
        <Grid>
          <span>Cell</span>
        </Grid>
      </Stack>,
    );

    await expectNoAxeViolations(container);
  });
});
