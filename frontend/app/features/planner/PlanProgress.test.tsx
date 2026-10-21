import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlanProgress, type RequestState } from "./PlanProgress";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function statusOf(step: string): string {
  const item = screen.getByText(step).closest("li");
  if (item === null) throw new Error(`no step ${step}`);
  return within(item).getByText(/^(Waiting|In progress|Done|Failed)/u).textContent;
}

function steps(plan: RequestState, heatmap: RequestState): string[] {
  render(<PlanProgress plan={plan} heatmap={heatmap} />);
  return ["Routing, weather, scoring", "Forecast map", "Timeline"].map(statusOf);
}

describe("PlanProgress", () => {
  it("shows routing, weather and scoring as one step in progress while the plan request runs", () => {
    expect(steps("loading", "idle")).toEqual(["In progress", "Waiting", "Waiting"]);
    expect(screen.getByText("Finding three truck routes")).toBeInTheDocument();
    expect(screen.getByText("Fetching the forecast at each checkpoint ETA")).toBeInTheDocument();
    expect(screen.getByText("Scoring risk and ranking")).toBeInTheDocument();
  });

  it("starts the forecast map step when the plan has arrived", () => {
    expect(steps("ready", "loading")).toEqual(["Done", "In progress", "Waiting"]);
  });

  it("finishes every step when the forecast has arrived", () => {
    expect(steps("ready", "ready")).toEqual(["Done", "Done", "Done"]);
  });

  it("marks the plan step failed and never starts the later ones when the plan request fails", () => {
    expect(steps("error", "idle")).toEqual(["Failed", "Waiting", "Waiting"]);
  });

  it("marks the forecast map failed, and the timeline waiting, when the forecast request fails", () => {
    expect(steps("ready", "error")).toEqual(["Done", "Failed", "Waiting"]);
  });

  it("does not start the forecast map before the plan is ready, whatever the forecast says", () => {
    expect(steps("loading", "ready")).toEqual(["In progress", "Waiting", "Done"]);
  });

  it("counts the seconds the plan request has taken, from the request and not from a script", () => {
    render(<PlanProgress plan="loading" heatmap="idle" />);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(screen.getByText("3 s")).toBeInTheDocument();
  });

  it("stops the clock when the plan request is over", () => {
    const { rerender } = render(<PlanProgress plan="loading" heatmap="idle" />);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    rerender(<PlanProgress plan="ready" heatmap="loading" />);

    expect(vi.getTimerCount()).toBe(0);
    expect(screen.queryByText(/^\d+ s$/u)).not.toBeInTheDocument();
  });
});
