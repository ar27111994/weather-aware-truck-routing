import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { copy } from "../../copy";
import { RISK_LEVELS, StackedBar } from "./StackedBar";
import StackedBarDemo from "./StackedBar.demo";

const none = { low: 0, moderate: 0, high: 0, severe: 0, no_travel: 0, unknown: 0 };

let observed: ((entries: { contentRect: { width: number } }[]) => void) | undefined;

class FakeResizeObserver {
  public constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
    observed = callback;
  }
  public observe(): void {
    observed?.([{ contentRect: { width: 200 } }]);
  }
  public disconnect(): void {
    observed = undefined;
  }
}

function installObserver(): void {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
}

afterEach(() => {
  observed = undefined;
});

describe("StackedBar", () => {
  it("exposes the six levels in severity order", () => {
    expect(RISK_LEVELS).toEqual(["low", "moderate", "high", "severe", "no_travel", "unknown"]);
  });

  it("names the image with the visible row text, prefixed by the section label", () => {
    installObserver();
    render(<StackedBar miles={{ ...none, low: 480.1, moderate: 32.3 }} />);

    const image = screen.getByRole("img");
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      `${copy.risk.low} 480.1 ${copy.form.interval.unit}`,
      `${copy.risk.moderate} 32.3 ${copy.form.interval.unit}`,
    ]);
    expect(image).toHaveAccessibleName(
      `${copy.route.milesByLevel}: ${rows.map((row) => row.textContent).join(", ")}`,
    );
  });

  it("formats miles with exactly one fraction digit and thousands separators", () => {
    installObserver();
    render(<StackedBar miles={{ ...none, low: 1234, high: 0.04 }} />);

    expect(
      screen.getByText(`${copy.risk.low} 1,234.0 ${copy.form.interval.unit}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`${copy.risk.high} 0.0 ${copy.form.interval.unit}`),
    ).toBeInTheDocument();
  });

  it("lists and draws only non-zero levels", () => {
    installObserver();
    const { container } = render(<StackedBar miles={{ ...none, moderate: 10, severe: 5 }} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText(new RegExp(copy.risk.low))).not.toBeInTheDocument();
    expect(container.querySelectorAll("svg > g")).toHaveLength(2);
  });

  it("shows an Unknown level with its own row", () => {
    installObserver();
    render(<StackedBar miles={{ ...none, low: 10, unknown: 2.5 }} />);

    expect(screen.getByRole("img")).toHaveAccessibleName(
      expect.stringContaining(`${copy.risk.unknown} 2.5 ${copy.form.interval.unit}`),
    );
  });

  it("draws nothing and lists nothing when every level is zero", () => {
    installObserver();
    const { container } = render(<StackedBar miles={none} />);

    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(container.querySelectorAll("svg > g")).toHaveLength(0);
    expect(screen.getByRole("img")).toHaveAccessibleName(copy.route.milesByLevel);
  });

  it("draws a pattern for every patterned level and none for Low", () => {
    installObserver();
    const { container } = render(
      <StackedBar miles={{ low: 1, moderate: 1, high: 1, severe: 1, no_travel: 1, unknown: 1 }} />,
    );

    expect(container.querySelectorAll("pattern")).toHaveLength(5);
  });

  it("keeps pattern ids unique across two bars", () => {
    installObserver();
    const miles = { low: 1, moderate: 1, high: 1, severe: 1, no_travel: 1, unknown: 1 };
    const { container } = render(
      <>
        <StackedBar miles={miles} />
        <StackedBar miles={miles} />
      </>,
    );

    const ids = Array.from(container.querySelectorAll("pattern"), (pattern) => pattern.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    ids.forEach((id) => {
      expect(container.querySelector(`rect[fill="url(#${id})"]`)).not.toBeNull();
    });
  });

  it("lays out with the fallback width before anything is measured", () => {
    class SilentObserver {
      public observe(): void {
        observed = undefined;
      }
      public disconnect(): void {
        observed = undefined;
      }
    }
    vi.stubGlobal("ResizeObserver", SilentObserver);
    const { container } = render(<StackedBar miles={{ ...none, low: 1, high: 1 }} />);

    expect(container.querySelectorAll("svg > g")).toHaveLength(2);
  });

  it("passes axe in the demo", async () => {
    installObserver();
    const { container } = render(<StackedBarDemo />);

    expect(screen.getAllByRole("img")).toHaveLength(3);
    await expectNoAxeViolations(container);
  });
});
