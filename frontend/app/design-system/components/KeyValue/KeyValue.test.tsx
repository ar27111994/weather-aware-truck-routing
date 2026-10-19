import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { KeyValue } from "./KeyValue";
import KeyValueDemo from "./KeyValue.demo";

const entries = [
  { label: "Distance", value: "512.4 mi" },
  { label: "Drive time", value: "7 h 44 min" },
];

describe("KeyValue", () => {
  it("renders a description list with one term and one description per entry", () => {
    const { container } = render(<KeyValue entries={entries} />);

    const list = container.querySelector("dl");
    expect(list).not.toBeNull();
    const terms = container.querySelectorAll("dl > div > dt");
    const descriptions = container.querySelectorAll("dl > div > dd");
    expect(Array.from(terms, (term) => term.textContent)).toEqual(["Distance", "Drive time"]);
    expect(Array.from(descriptions, (description) => description.textContent)).toEqual([
      "512.4 mi",
      "7 h 44 min",
    ]);
  });

  it("exposes each label/value pair through the term and definition roles", () => {
    render(<KeyValue entries={entries} />);

    const terms = screen.getAllByRole("term");
    const definitions = screen.getAllByRole("definition");
    expect(terms).toHaveLength(2);
    expect(terms[0]).toHaveTextContent("Distance");
    expect(definitions[0]).toHaveTextContent("512.4 mi");
  });

  it("accepts rich values", () => {
    render(<KeyValue entries={[{ label: "Route", value: <strong>Route B</strong> }]} />);

    expect(screen.getByText("Route B").tagName).toBe("STRONG");
  });

  it("renders nothing visible for an empty list but stays valid markup", async () => {
    const { container } = render(<KeyValue entries={[]} />);

    expect(container.querySelectorAll("dt")).toHaveLength(0);
    await expectNoAxeViolations(container);
  });

  it("supports both layouts", () => {
    const { container, rerender } = render(<KeyValue entries={entries} />);
    expect(container.querySelector("dl")).toHaveAttribute("data-layout", "stacked");

    rerender(<KeyValue entries={entries} layout="inline" />);

    expect(container.querySelector("dl")).toHaveAttribute("data-layout", "inline");
  });

  it("passes axe in the demo", async () => {
    const { container } = render(<KeyValueDemo />);

    expect(screen.getAllByRole("term").length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
  });
});
