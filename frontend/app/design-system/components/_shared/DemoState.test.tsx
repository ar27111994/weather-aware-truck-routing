import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DemoGrid, DemoState } from "./DemoState";

describe("DemoState", () => {
  it("titles each state with a heading and renders its content", () => {
    render(
      <DemoGrid>
        <DemoState title="Invalid">
          <p>content</p>
        </DemoState>
        <DemoState title="Disabled">
          <p>other</p>
        </DemoState>
      </DemoGrid>,
    );

    expect(screen.getByRole("heading", { level: 3, name: "Invalid" })).toBeInTheDocument();
    expect(screen.getByText("content")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(2);
  });
});
