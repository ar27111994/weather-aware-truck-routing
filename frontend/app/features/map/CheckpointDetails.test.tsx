import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { minimalPlan } from "../../api/mocks";
import { CheckpointDetails } from "./CheckpointDetails";
import { checkpointDetails } from "./checkpoint-details";
import type { CheckpointDetailsModel } from "./checkpoint-details";

function model(overrides: Partial<CheckpointDetailsModel> = {}): CheckpointDetailsModel {
  const details = checkpointDetails(minimalPlan(), { routeId: "B", index: 1 }, "en-US");
  if (!details) throw new Error("the minimal plan has checkpoint B/1");
  return { ...details, ...overrides };
}

describe("CheckpointDetails", () => {
  it("shows the level, route, checkpoint, ETA, distance and the factor table with level badges", () => {
    render(<CheckpointDetails details={model()} onClose={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Checkpoint 2 of 2" })).toBeInTheDocument();
    expect(screen.getByText("ETA")).toBeInTheDocument();
    expect(screen.getByText(/mi from origin, covers/)).toBeInTheDocument();
    const table = screen.getByRole("table");
    const wind = within(table).getByRole("row", { name: /Wind/ });
    expect(within(wind).getByText("12.3 mph")).toBeInTheDocument();
    expect(within(table).getByText("not scored (sustained wind is scored)")).toBeInTheDocument();
    expect(screen.getByText("Wind 12.3 mph (Low)")).toBeInTheDocument();
    expect(screen.getByText("None")).toBeInTheDocument();
  });

  it("adds the incomplete-data note after the forecast time", () => {
    render(
      <CheckpointDetails
        details={model({ incomplete: "Incomplete data: Snow" })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/Forecast for .* Incomplete data: Snow/)).toBeInTheDocument();
  });

  it("closes from its close button", async () => {
    const onClose = vi.fn();
    render(<CheckpointDetails details={model()} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "Close checkpoint details" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
