import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { t, tList } from "../../foundation/strings";
import { ProgressSteps } from "./ProgressSteps";
import type { ProgressStatus, ProgressStepItem } from "./ProgressSteps";
import { demo } from "./ProgressSteps.demo";

const LABEL = t("progress.label");
const STATUSES: readonly ProgressStatus[] = ["pending", "active", "done", "failed"];

/** Steps named "Step 1", "Step 2", ... carrying the given statuses. */
function makeSteps(...statuses: readonly ProgressStatus[]): ProgressStepItem[] {
  return statuses.map((status, index) => ({
    id: `step-${String(index + 1)}`,
    label: `Step ${String(index + 1)}`,
    status,
  }));
}

/** The one sentence the live region is expected to hold for a step and its status. */
function sentence(label: string, status: ProgressStatus): string {
  return `${label}: ${t(`progress.state.${status}`)}`;
}

function liveRegion(): HTMLElement {
  return screen.getByRole("status");
}

describe("ProgressSteps list", () => {
  it("is an ordered list named by its label with one item per step", () => {
    render(
      <ProgressSteps label={LABEL} steps={makeSteps("done", "active", "pending", "pending")} />,
    );

    const list = screen.getByRole("list", { name: LABEL });
    expect(list.tagName).toBe("OL");
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
  });

  it("keeps the list role that `list-style: none` takes away in Safari", () => {
    render(<ProgressSteps label={LABEL} steps={makeSteps("active")} />);

    expect(screen.getByRole("list", { name: LABEL })).toHaveAttribute("role", "list");
  });

  it("marks the active step, and only that one, as the current step", () => {
    render(
      <ProgressSteps label={LABEL} steps={makeSteps("done", "failed", "active", "pending")} />,
    );

    const marks = screen.getAllByRole("listitem").map((item) => item.getAttribute("aria-current"));
    expect(marks).toEqual([null, null, "step", null]);
  });

  it("shows the step labels in the order given", () => {
    render(<ProgressSteps label={LABEL} steps={makeSteps("done", "active", "pending")} />);

    const labels = screen.getAllByText(/^Step \d$/).map((element) => element.textContent);
    expect(labels).toEqual(["Step 1", "Step 2", "Step 3"]);
  });

  it.each(STATUSES)("shows the %s status as visible text and as data-status", (status) => {
    render(<ProgressSteps label={LABEL} steps={makeSteps(status)} />);

    const item = screen.getByRole("listitem");
    expect(item).toHaveAttribute("data-status", status);
    expect(within(item).getByText(t(`progress.state.${status}`))).toBeVisible();
  });

  it("renders an empty list when there are no steps", () => {
    render(<ProgressSteps label={LABEL} steps={[]} />);

    const list = screen.getByRole("list", { name: LABEL });
    expect(within(list).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("merges a caller class name onto the root", () => {
    const { container } = render(
      <ProgressSteps label={LABEL} steps={makeSteps("pending")} className="custom" />,
    );

    expect(container.firstElementChild).toHaveClass("custom");
  });
});

describe("ProgressSteps status icons", () => {
  it("draws a decorative ring, no spinner and no glyph for a pending step", () => {
    const { container } = render(<ProgressSteps label={LABEL} steps={makeSteps("pending")} />);

    const item = screen.getByRole("listitem");
    expect(item.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("shows an indeterminate progressbar named after the step for an active step", () => {
    render(<ProgressSteps label={LABEL} steps={makeSteps("active")} />);

    const bar = within(screen.getByRole("listitem")).getByRole("progressbar", { name: "Step 1" });
    expect(bar).not.toHaveAttribute("aria-valuenow");
  });

  it("puts a progressbar only in the active step", () => {
    render(
      <ProgressSteps label={LABEL} steps={makeSteps("done", "active", "pending", "failed")} />,
    );

    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.getByRole("progressbar").closest("li")).toHaveAttribute("data-status", "active");
  });

  it("draws a 20 px check glyph, hidden from assistive tech, for a done step", () => {
    const { container } = render(<ProgressSteps label={LABEL} steps={makeSteps("done")} />);

    const glyph = container.querySelector("svg");
    expect(glyph).toHaveClass("lucide-circle-check");
    expect(glyph).toHaveAttribute("width", "20");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("draws a 20 px cross glyph, hidden from assistive tech, for a failed step", () => {
    const { container } = render(<ProgressSteps label={LABEL} steps={makeSteps("failed")} />);

    const glyph = container.querySelector("svg");
    expect(glyph).toHaveClass("lucide-circle-x");
    expect(glyph).toHaveAttribute("width", "20");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});

describe("ProgressSteps details", () => {
  it("lists the details of a step as a nested list under its label", () => {
    const details = tList("progress.serverSub");
    render(
      <ProgressSteps
        label={LABEL}
        steps={[{ id: "server", label: t("progress.server"), status: "active", details }]}
      />,
    );

    const nested = within(screen.getByRole("list", { name: LABEL })).getByRole("list");
    const texts = within(nested)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(texts).toEqual([...details]);
  });

  it("renders no nested list for a step without details", () => {
    render(<ProgressSteps label={LABEL} steps={makeSteps("active")} />);

    expect(within(screen.getByRole("listitem")).queryByRole("list")).not.toBeInTheDocument();
  });

  it("renders no nested list for an empty details array", () => {
    render(
      <ProgressSteps
        label={LABEL}
        steps={[{ id: "server", label: "Server", status: "active", details: [] }]}
      />,
    );

    expect(within(screen.getByRole("listitem")).queryByRole("list")).not.toBeInTheDocument();
  });
});

describe("ProgressSteps elapsed readout", () => {
  it("shows the elapsed seconds on the active step", () => {
    render(
      <ProgressSteps
        label={LABEL}
        steps={[{ id: "server", label: "Server", status: "active", elapsedSeconds: 12 }]}
      />,
    );

    expect(screen.getByText(t("progress.elapsed", { s: 12 }))).toBeVisible();
  });

  it("shows zero seconds at the start instead of treating it as missing", () => {
    render(
      <ProgressSteps
        label={LABEL}
        steps={[{ id: "server", label: "Server", status: "active", elapsedSeconds: 0 }]}
      />,
    );

    expect(screen.getByText(t("progress.elapsed", { s: 0 }))).toBeVisible();
  });

  it("drops the fraction instead of rounding up", () => {
    render(
      <ProgressSteps
        label={LABEL}
        steps={[{ id: "server", label: "Server", status: "active", elapsedSeconds: 12.9 }]}
      />,
    );

    expect(screen.getByText(t("progress.elapsed", { s: 12 }))).toBeVisible();
  });

  it("shows no readout on an active step that has no value", () => {
    render(<ProgressSteps label={LABEL} steps={makeSteps("active")} />);

    expect(screen.getByRole("listitem")).not.toHaveTextContent(/\d+ s\b/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "shows no readout when the value is %s instead of printing it",
    (elapsedSeconds) => {
      render(
        <ProgressSteps
          label={LABEL}
          steps={[{ id: "server", label: "Server", status: "active", elapsedSeconds }]}
        />,
      );

      expect(screen.getByRole("listitem")).not.toHaveTextContent(/NaN|Infinity/);
    },
  );

  it.each(["pending", "done", "failed"] as const)(
    "hides the readout on a %s step even when a value is given",
    (status) => {
      render(
        <ProgressSteps
          label={LABEL}
          steps={[{ id: "server", label: "Server", status, elapsedSeconds: 12 }]}
        />,
      );

      expect(screen.queryByText(t("progress.elapsed", { s: 12 }))).not.toBeInTheDocument();
    },
  );
});

describe("ProgressSteps live region", () => {
  it("is a polite, atomic status region that is always rendered", () => {
    render(<ProgressSteps label={LABEL} steps={[]} />);

    const region = liveRegion();
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
  });

  it("is not part of the list", () => {
    render(<ProgressSteps label={LABEL} steps={makeSteps("active")} />);

    expect(screen.getByRole("list", { name: LABEL })).not.toContainElement(liveRegion());
  });

  interface Case {
    readonly name: string;
    readonly statuses: readonly ProgressStatus[];
    readonly expected: string;
  }

  const CASES: readonly Case[] = [
    {
      name: "a failed step before active and done ones",
      statuses: ["done", "failed", "active"],
      expected: sentence("Step 2", "failed"),
    },
    {
      name: "the first failed step when several failed",
      statuses: ["failed", "active", "failed"],
      expected: sentence("Step 1", "failed"),
    },
    {
      name: "the active step when nothing failed",
      statuses: ["done", "active", "pending"],
      expected: sentence("Step 2", "active"),
    },
    {
      name: "the first active step when several are active",
      statuses: ["active", "active"],
      expected: sentence("Step 1", "active"),
    },
    {
      name: "the last done step when nothing is active",
      statuses: ["done", "done", "pending"],
      expected: sentence("Step 2", "done"),
    },
    {
      name: "the final step when everything is done",
      statuses: ["done", "done", "done"],
      expected: sentence("Step 3", "done"),
    },
    { name: "nothing while every step is pending", statuses: ["pending", "pending"], expected: "" },
    { name: "nothing when there are no steps", statuses: [], expected: "" },
  ];

  it.each(CASES)("announces $name", ({ statuses, expected }) => {
    render(<ProgressSteps label={LABEL} steps={makeSteps(...statuses)} />);

    expect(liveRegion().textContent).toBe(expected);
  });

  it("changes its sentence on every transition of a step", () => {
    const { rerender } = render(<ProgressSteps label={LABEL} steps={makeSteps("pending")} />);
    expect(liveRegion().textContent).toBe("");

    const transitions = ["active", "done", "failed"] as const;
    for (const status of transitions) {
      rerender(<ProgressSteps label={LABEL} steps={makeSteps(status)} />);

      expect(liveRegion().textContent).toBe(sentence("Step 1", status));
    }
  });

  it("moves on to the next step when the previous one is done", () => {
    const { rerender } = render(
      <ProgressSteps label={LABEL} steps={makeSteps("active", "pending")} />,
    );
    expect(liveRegion().textContent).toBe(sentence("Step 1", "active"));

    rerender(<ProgressSteps label={LABEL} steps={makeSteps("done", "active")} />);

    expect(liveRegion().textContent).toBe(sentence("Step 2", "active"));
  });

  it("does not announce the elapsed counter as it ticks", () => {
    const steps = (elapsedSeconds: number): ProgressStepItem[] => [
      { id: "server", label: "Server", status: "active", elapsedSeconds },
    ];
    const { rerender } = render(<ProgressSteps label={LABEL} steps={steps(12)} />);
    const before = liveRegion().textContent;

    rerender(<ProgressSteps label={LABEL} steps={steps(13)} />);

    expect(liveRegion().textContent).toBe(before);
    expect(before).toBe(sentence("Server", "active"));
  });
});

describe("ProgressSteps accessibility", () => {
  it("has no violations with every status, details and an elapsed readout", async () => {
    const { container } = render(
      <ProgressSteps
        label={LABEL}
        steps={[
          { id: "done", label: "Done step", status: "done" },
          {
            id: "active",
            label: "Active step",
            status: "active",
            details: ["First part", "Second part"],
            elapsedSeconds: 7,
          },
          { id: "failed", label: "Failed step", status: "failed" },
          { id: "pending", label: "Pending step", status: "pending" },
        ]}
      />,
    );

    await expectNoAxeViolations(container);
  });

  it("has no violations with no steps", async () => {
    const { container } = render(<ProgressSteps label={LABEL} steps={[]} />);

    await expectNoAxeViolations(container);
  });
});

describe("ProgressSteps demo", () => {
  function demoNode(id: string): ReactNode {
    return demo.states.find((state) => state.id === id)?.node;
  }

  it("shows the five honest planner states", () => {
    expect(demo.name).toBe("ProgressSteps");
    expect(demo.states.map((state) => state.id)).toEqual([
      "all-pending",
      "server-active",
      "heatmap-active",
      "all-done",
      "failed",
    ]);
  });

  it.each(demo.states)(
    "renders the $id state as the planner list without violations",
    async (state) => {
      const { container } = render(state.node);

      const list = screen.getByRole("list", { name: LABEL });
      for (const label of [t("progress.server"), t("progress.heatmap"), t("progress.timeline")]) {
        expect(within(list).getByText(label)).toBeVisible();
      }
      await expectNoAxeViolations(container);
    },
  );

  it("maps the grouped server step to the single plan request with its three stages", () => {
    render(demoNode("server-active"));

    const nested = within(screen.getByRole("list", { name: LABEL })).getByRole("list");
    const stages = within(nested)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(stages).toEqual([...tList("progress.serverSub")]);
    expect(screen.getByText(t("progress.elapsed", { s: 12 }))).toBeVisible();
    expect(liveRegion().textContent).toBe(sentence(t("progress.server"), "active"));
  });

  it("moves the activity to the forecast map once the server step is done", () => {
    render(demoNode("heatmap-active"));

    expect(liveRegion().textContent).toBe(sentence(t("progress.heatmap"), "active"));
  });

  it("finishes on the timeline when everything is done", () => {
    render(demoNode("all-done"));

    expect(liveRegion().textContent).toBe(sentence(t("progress.timeline"), "done"));
  });

  it("announces nothing while every planner step is pending", () => {
    render(demoNode("all-pending"));

    expect(liveRegion().textContent).toBe("");
  });

  it("announces the failed step", () => {
    render(demoNode("failed"));

    expect(liveRegion().textContent).toContain(t("progress.state.failed"));
  });
});
