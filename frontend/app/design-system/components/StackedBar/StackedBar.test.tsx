import { act, render, screen } from "@testing-library/react";
import { Fragment } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { defined } from "../../../../test/defined";
import { t } from "../../foundation/strings";
import { StackedBar } from "./StackedBar";
import { demo } from "./StackedBar.demo";

const none = { low: 0, moderate: 0, high: 0, severe: 0, no_travel: 0, unknown: 0 };

type Report = (entries: { contentRect: { width: number } }[]) => void;

let observed: Report | undefined;
let disconnects = 0;

class FakeResizeObserver {
  public constructor(callback: Report) {
    observed = callback;
  }
  public observe(): void {
    observed?.([{ contentRect: { width: 200 } }]);
  }
  public disconnect(): void {
    observed = undefined;
    disconnects += 1;
  }
}

function installObserver(): void {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
}

/** The drawn segments from left to right: where each starts and how wide it is (its fill rectangle). */
function segmentBoxes(container: HTMLElement): { x: number; width: number }[] {
  return Array.from(container.querySelectorAll("svg > g"), (group) => {
    const fill = defined(group.querySelector("rect"), "the fill rectangle of a segment");
    return { x: Number(fill.getAttribute("x")), width: Number(fill.getAttribute("width")) };
  });
}

beforeEach(() => {
  disconnects = 0;
});

afterEach(() => {
  observed = undefined;
});

describe("StackedBar", () => {
  it("draws the five scored levels from Low to No Travel, then Unknown", () => {
    installObserver();
    render(
      <StackedBar miles={{ low: 1, moderate: 1, high: 1, severe: 1, no_travel: 1, unknown: 1 }} />,
    );

    const words = [
      t("risk.low"),
      t("risk.moderate"),
      t("risk.high"),
      t("risk.severe"),
      t("risk.no_travel"),
      t("risk.unknown"),
    ];
    expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual(
      words.map((word) => `${word} 1.0 ${t("form.interval.unit")}`),
    );
  });

  it("styles with presentation attributes only, because the CSP forbids inline styles", () => {
    installObserver();
    const { container } = render(
      <StackedBar miles={{ low: 1, moderate: 1, high: 1, severe: 1, no_travel: 1, unknown: 1 }} />,
    );

    expect(container.querySelectorAll("[style]")).toHaveLength(0);
    expect(container.querySelector("svg > g > rect")).toHaveAttribute(
      "fill",
      "var(--risk-low-fill)",
    );
  });

  it("names the image with the visible row text, prefixed by the section label", () => {
    installObserver();
    render(<StackedBar miles={{ ...none, low: 480.1, moderate: 32.3 }} />);

    const image = screen.getByRole("img");
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      `${t("risk.low")} 480.1 ${t("form.interval.unit")}`,
      `${t("risk.moderate")} 32.3 ${t("form.interval.unit")}`,
    ]);
    expect(image).toHaveAccessibleName(
      `${t("route.milesByLevel")}: ${rows.map((row) => row.textContent).join(", ")}`,
    );
  });

  it("formats miles with exactly one fraction digit and thousands separators", () => {
    installObserver();
    render(<StackedBar miles={{ ...none, low: 1234, high: 0.04 }} />);

    expect(
      screen.getByText(`${t("risk.low")} 1,234.0 ${t("form.interval.unit")}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`${t("risk.high")} 0.0 ${t("form.interval.unit")}`),
    ).toBeInTheDocument();
  });

  it("lists and draws only non-zero levels", () => {
    installObserver();
    const { container } = render(<StackedBar miles={{ ...none, moderate: 10, severe: 5 }} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText(new RegExp(t("risk.low")))).not.toBeInTheDocument();
    expect(container.querySelectorAll("svg > g")).toHaveLength(2);
  });

  it("shows an Unknown level with its own row", () => {
    installObserver();
    render(<StackedBar miles={{ ...none, low: 10, unknown: 2.5 }} />);

    expect(screen.getByRole("img")).toHaveAccessibleName(
      expect.stringContaining(`${t("risk.unknown")} 2.5 ${t("form.interval.unit")}`),
    );
  });

  it("draws nothing and lists nothing when every level is zero", () => {
    installObserver();
    const { container } = render(<StackedBar miles={none} />);

    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(container.querySelectorAll("svg > g")).toHaveLength(0);
    expect(screen.getByRole("img")).toHaveAccessibleName(t("route.milesByLevel"));
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

  it("lays out at the width the observer reports (R3-31)", () => {
    installObserver();
    const { container } = render(<StackedBar miles={{ ...none, low: 1, high: 1 }} />);

    // 200 px less the 1 px gap, shared by two levels with the same miles.
    expect(segmentBoxes(container)).toEqual([
      { x: 0, width: 99.5 },
      { x: 100.5, width: 99.5 },
    ]);
  });

  it("lays out again when the observer reports another width (R3-31)", () => {
    installObserver();
    const { container } = render(<StackedBar miles={{ ...none, low: 1, high: 1 }} />);

    act(() => {
      defined(observed, "the observer's callback")([{ contentRect: { width: 100 } }]);
    });

    expect(segmentBoxes(container)).toEqual([
      { x: 0, width: 49.5 },
      { x: 50.5, width: 49.5 },
    ]);
  });

  it("stops observing when the bar unmounts (R3-31)", () => {
    installObserver();
    const { unmount } = render(<StackedBar miles={{ ...none, low: 1 }} />);
    expect(disconnects).toBe(0);

    unmount();

    expect(disconnects).toBe(1);
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
    // 320 px (the fallback) less the 1 px gap, shared by two levels with the same miles.
    expect(segmentBoxes(container)).toEqual([
      { x: 0, width: 159.5 },
      { x: 160.5, width: 159.5 },
    ]);
  });

  it("keeps the fallback width where the browser has no ResizeObserver (jsdom, old WebViews)", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { container } = render(<StackedBar miles={{ ...none, low: 1, high: 1 }} />);

    expect(container.querySelectorAll("svg > g")).toHaveLength(2);
    expect(segmentBoxes(container)).toEqual([
      { x: 0, width: 159.5 },
      { x: 160.5, width: 159.5 },
    ]);
  });

  it("passes axe in the demo", async () => {
    installObserver();
    const { container } = render(
      <>
        {demo.states.map((state) => (
          <Fragment key={state.id}>{state.node}</Fragment>
        ))}
      </>,
    );

    expect(screen.getAllByRole("img")).toHaveLength(3);
    await expectNoAxeViolations(container);
  });
});
