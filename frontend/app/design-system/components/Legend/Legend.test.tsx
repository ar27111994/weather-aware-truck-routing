import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { bandWords, boundaryNote } from "../../../lib/boundary-text";
import { RISK_RULES } from "../../../lib/risk";
import { t } from "../../foundation/strings";
import { Legend, LegendRamp, LegendRiskList } from "./Legend";

const WIND_TICKS = ["15", "25", "35", "45", "55"] as const;

function windBands(): readonly [string, string, string, string, string] {
  return bandWords("wind", RISK_RULES);
}

describe("Legend", () => {
  it("is a group named by its title, with the rows and the footnote", () => {
    render(
      <Legend title="Risk level" footnote={boundaryNote(RISK_RULES)}>
        <p>rows go here</p>
      </Legend>,
    );

    const group = screen.getByRole("group", { name: "Risk level" });
    expect(group).toHaveTextContent("rows go here");
    expect(group).toHaveTextContent("A value on a boundary belongs to the higher band");
    expect(group).toHaveAttribute("data-variant", "overlay");
  });

  it("works without a footnote and as the inline page variant", () => {
    render(
      <Legend title="Wind speed, mph" variant="inline">
        <p>rows</p>
      </Legend>,
    );

    const group = screen.getByRole("group", { name: "Wind speed, mph" });
    expect(group).toHaveAttribute("data-variant", "inline");
    expect(group.querySelectorAll("p")).toHaveLength(2);
  });

  it("merges a caller class name", () => {
    render(
      <Legend title="Risk level" className="custom">
        <p>rows</p>
      </Legend>,
    );

    expect(screen.getByRole("group", { name: "Risk level" })).toHaveClass("custom");
  });

  describe("collapsible", () => {
    it("puts the disclosure in the heading level the page needs (R1-32)", () => {
      render(
        <Legend title="Risk level" isCollapsible headingLevel={2}>
          <p>rows</p>
        </Legend>,
      );

      expect(screen.getByRole("heading", { level: 2 })).toContainElement(
        screen.getByRole("button", { name: "Legend" }),
      );
      expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
    });

    it("starts open with a Legend disclosure button in a level 3 heading", () => {
      render(
        <Legend title="Risk level" isCollapsible>
          <p>rows</p>
        </Legend>,
      );

      const button = screen.getByRole("button", { name: "Legend" });
      expect(button).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("heading", { level: 3 })).toContainElement(button);
      expect(screen.getByText("rows")).toBeVisible();
      expect(screen.getByRole("group", { name: "Risk level" })).toBeInTheDocument();
    });

    it("folds away and opens again with the mouse and the keyboard", async () => {
      const user = userEvent.setup();
      render(
        <Legend title="Risk level" isCollapsible>
          <p>rows</p>
        </Legend>,
      );
      const button = screen.getByRole("button", { name: "Legend" });

      await user.click(button);
      expect(button).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByText("rows")).not.toBeVisible();

      button.focus();
      await user.keyboard("{Enter}");
      expect(button).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("rows")).toBeVisible();

      await user.keyboard(" ");
      expect(button).toHaveAttribute("aria-expanded", "false");
    });

    it("can start folded", () => {
      render(
        <Legend title="Risk level" isCollapsible defaultExpanded={false}>
          <p>rows</p>
        </Legend>,
      );

      expect(screen.getByRole("button", { name: "Legend" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      expect(screen.getByText("rows")).not.toBeVisible();
    });
  });

  it("has no accessibility violations, folded or open", async () => {
    const { container } = render(
      <div>
        <Legend title="Risk level" footnote="note">
          <LegendRiskList />
        </Legend>
        <Legend title="Wind speed, mph" isCollapsible>
          <LegendRamp field="wind" ticks={WIND_TICKS} bands={windBands()} unit="mph" />
        </Legend>
        <Legend title="Rain, in/hr" isCollapsible defaultExpanded={false}>
          <LegendRiskList />
        </Legend>
      </div>,
    );

    await expectNoAxeViolations(container);
  });
});

describe("LegendRiskList", () => {
  it("lists the six levels in order, Unknown last", () => {
    render(<LegendRiskList />);

    const words = within(screen.getByRole("list"))
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(words).toEqual(["Low", "Moderate", "High", "Severe", "No Travel", "Unknown"]);
  });

  it("gives every row a shape icon and a patterned swatch that assistive technology skips", () => {
    render(<LegendRiskList />);

    for (const item of screen.getAllByRole("listitem")) {
      expect(item.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(item.querySelector("[data-level]")).toHaveAttribute("aria-hidden", "true");
    }
    expect(
      screen
        .getAllByRole("listitem")
        .map((item) => item.querySelector("[data-level]")?.getAttribute("data-level")),
    ).toEqual(["low", "moderate", "high", "severe", "no_travel", "unknown"]);
  });

  it("shows a hint after the word where one is given", () => {
    render(<LegendRiskList hints={{ unknown: t("legend.unknownHint"), low: "under 25 mph" }} />);

    expect(screen.getByText("Missing weather data")).toBeInTheDocument();
    expect(screen.getByText("under 25 mph")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")[1]).toHaveTextContent(/^Moderate$/);
  });

  it("merges a caller class name", () => {
    render(<LegendRiskList className="custom" />);

    expect(screen.getByRole("list")).toHaveClass("custom");
  });
});

describe("LegendRamp", () => {
  it("draws five steps for the field, low to high", () => {
    const { container } = render(
      <LegendRamp
        field="rain"
        ticks={["0.01", "0.10", "0.25", "0.50", "1.00"]}
        bands={["a", "b", "c", "d", "e"]}
      />,
    );

    const steps = container.querySelectorAll("[data-step]");
    expect(steps).toHaveLength(5);
    expect(Array.from(steps, (step) => step.getAttribute("data-step"))).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(Array.from(steps, (step) => step.getAttribute("data-field"))).toEqual(
      Array<string>(5).fill("rain"),
    );
  });

  it("reads each band to screen readers and keeps the printed thresholds visual only", () => {
    render(<LegendRamp field="wind" ticks={WIND_TICKS} bands={windBands()} />);

    for (const band of windBands()) {
      // Present and not hidden by any ancestor: that is what a screen reader gets to read.
      expect(screen.getByText(band).closest("[aria-hidden='true']")).toBeNull();
    }
    for (const tick of WIND_TICKS) {
      expect(screen.getByText(tick)).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("prints the unit after the last step and a note under the ramp when given", () => {
    render(
      <LegendRamp
        field="wind"
        ticks={WIND_TICKS}
        bands={windBands()}
        unit="mph"
        note={t("legend.notShadedWind")}
      />,
    );

    expect(screen.getByText("mph")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Not shaded: under 15 mph")).toBeInTheDocument();
  });

  it("works without a unit or a note, and merges a class name", () => {
    const { container } = render(
      <LegendRamp
        field="snow"
        ticks={["0.01", "0.5", "1.0", "2.0", "3.0"]}
        bands={["a", "b", "c", "d", "e"]}
        className="custom"
      />,
    );

    expect(container.querySelectorAll("li")).toHaveLength(5);
    expect(container.querySelector("p")).toBeNull();
    expect(container.firstElementChild).toHaveClass("custom");
  });

  it("writes no inline styles (strict CSP)", () => {
    const { container } = render(
      <Legend title="Risk level">
        <LegendRiskList />
        <LegendRamp field="wind" ticks={WIND_TICKS} bands={windBands()} unit="mph" />
      </Legend>,
    );

    expect(container.querySelectorAll("[style]")).toHaveLength(0);
  });
});
