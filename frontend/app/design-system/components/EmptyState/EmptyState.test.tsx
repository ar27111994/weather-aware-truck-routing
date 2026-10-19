import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { copy } from "../../copy";
import { expectNoAxeViolations } from "../../../../test/axe";
import { EmptyState } from "./EmptyState";
import EmptyStateDemo from "./EmptyState.demo";

describe("EmptyState", () => {
  it("shows the title as a heading and the body", () => {
    render(<EmptyState title={copy.empty.title}>{copy.empty.body}</EmptyState>);

    expect(screen.getByRole("heading", { name: copy.empty.title })).toBeInTheDocument();
    expect(screen.getByText(copy.empty.body)).toBeInTheDocument();
  });

  it("lists the steps in an ordered list labelled by its heading", () => {
    render(
      <EmptyState title={copy.empty.title} stepsLabel="How it works" steps={copy.empty.steps}>
        {copy.empty.body}
      </EmptyState>,
    );

    const list = screen.getByRole("list", { name: "How it works" });
    expect(list.tagName).toBe("OL");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(copy.empty.steps);
  });

  it("renders no list and no steps heading without steps", () => {
    render(<EmptyState title={copy.empty.title}>{copy.empty.body}</EmptyState>);

    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading")).toHaveLength(1);
  });

  it("renders the action the caller passes", () => {
    render(
      <EmptyState title={copy.empty.title} action={<a href="#demo">{copy.empty.tryScenario}</a>}>
        {copy.empty.body}
      </EmptyState>,
    );

    expect(screen.getByRole("link", { name: copy.empty.tryScenario })).toBeInTheDocument();
  });

  it("passes axe in the demo", async () => {
    const { container } = render(<EmptyStateDemo />);

    expect(screen.getByRole("link", { name: copy.empty.tryScenario })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
