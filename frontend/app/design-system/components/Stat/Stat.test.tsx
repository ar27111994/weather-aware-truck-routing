import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Stat } from "./Stat";
import StatDemo from "./Stat.demo";

describe("Stat", () => {
  it("associates the label with the value through description-list semantics", () => {
    const { container } = render(<Stat label="Distance" value="512.4" />);

    expect(container.querySelector("dl > div > dt")).toHaveTextContent("Distance");
    expect(container.querySelector("dl > div > dd")).toHaveTextContent("512.4");
    expect(screen.getByRole("term")).toHaveTextContent("Distance");
    expect(screen.getByRole("definition")).toHaveTextContent("512.4");
  });

  it("shows the unit after the value in the same definition", () => {
    render(<Stat label="Distance" value="512.4" unit="mi" />);

    expect(screen.getByRole("definition")).toHaveTextContent("512.4 mi");
    expect(screen.getByText("mi")).toBeInTheDocument();
  });

  it("omits the unit and the delta when they are not given", () => {
    render(<Stat label="Distance" value="512.4" />);

    expect(screen.getAllByRole("definition")).toHaveLength(1);
    expect(screen.getByRole("definition").textContent).toBe("512.4");
  });

  it("shows the delta text as a second definition of the same label", () => {
    render(<Stat label="Drive time" value="7 h 44 min" delta="12 min longer than Route A" />);

    const definitions = screen.getAllByRole("definition");
    expect(definitions).toHaveLength(2);
    expect(definitions[1]).toHaveTextContent("12 min longer than Route A");
  });

  it("passes axe in the demo", async () => {
    const { container } = render(<StatDemo />);

    expect(screen.getAllByRole("term").length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
  });
});
