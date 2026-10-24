import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Route } from "../../api/contract";
import { at } from "../../lib/checked";
import { expectNoAxeViolations, warmUpAxe } from "../../../test/axe";
import { planFor, shortRoute } from "../../../test/plans";
import { tripStore } from "../../state";
import { CheckpointTable } from "./CheckpointTable";
import { checkpointClock } from "./route-format";

// A sortable table is scanned by axe; a machine running other jobs can take longer than 5 s over it.
vi.setConfig({ testTimeout: 20_000 });

const fullRoute = at(planFor("mixed").routes, 0);
/** Six rows are enough for every behaviour, and a 40-row table is slow to render in jsdom. */
const route = shortRoute(fullRoute, 6);

beforeAll(async () => {
  await warmUpAxe();
}, 60_000);

beforeEach(() => {
  act(() => {
    tripStore.actions.hoverCheckpoint(null);
  });
});

/** The data rows (the header row is the first). */
function rows(): HTMLElement[] {
  return screen.getAllByRole("row").slice(1);
}

function indexes(): string[] {
  return rows().map((row) => within(row).getByRole("rowheader").textContent);
}

function withCheckpoint(
  base: Route,
  position: number,
  patch: (checkpoint: Route["checkpoints"][number]) => Route["checkpoints"][number],
): Route {
  return {
    ...base,
    checkpoints: base.checkpoints.map((checkpoint, index) =>
      index === position ? patch(checkpoint) : checkpoint,
    ),
  };
}

describe("CheckpointTable", () => {
  it("is a region named for the route, holding one row per checkpoint in order from the origin", () => {
    render(<CheckpointTable route={fullRoute} />);

    expect(
      screen.getByRole("region", { name: `Checkpoints for Route ${fullRoute.route_id}` }),
    ).toBeInTheDocument();
    expect(rows()).toHaveLength(fullRoute.checkpoints.length);
    expect(indexes().slice(0, 3)).toEqual(["0", "1", "2"]);
  }, 30_000);

  it("names every column, with its unit", () => {
    render(<CheckpointTable route={route} />);

    const headers = screen.getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers).toEqual([
      "#",
      "Distance (mi)",
      "ETA (local)",
      "Level",
      "Wind (mph)",
      "Gust (mph)",
      "Rain (in/hr)",
      "Snow (in/hr)",
      "Temp (°F)",
      "Load rule",
    ]);
  });

  it("shows the ETA on the checkpoint's own clock, the readings at the precision the domain uses and the level of each factor", () => {
    render(<CheckpointTable route={route} />);

    const first = at(rows(), 0);
    const origin = at(route.checkpoints, 0);
    expect(within(first).getByText(checkpointClock(origin, "en-US"))).toBeInTheDocument();
    expect(within(first).getAllByText("0.0").length).toBeGreaterThan(0);
    expect(
      within(first).getAllByText((origin.weather.wind_mph ?? 0).toFixed(1)).length,
    ).toBeGreaterThan(0);
    // Level, plus the wind, rain and snow factor levels: four risk words in the row.
    const words = within(first).getAllByText(/^(Low|Moderate|High|Severe|No Travel|Unknown)$/u);
    expect(words).toHaveLength(4);
  });

  it("says None when no load rule fired and names the rule that did", () => {
    const fired = withCheckpoint(route, 1, (checkpoint) => ({
      ...checkpoint,
      risk: { ...checkpoint.risk, load_rule: "LR-2" },
    }));

    render(<CheckpointTable route={fired} />);

    expect(within(at(rows(), 0)).getByText("None")).toBeInTheDocument();
    expect(within(at(rows(), 1)).getByText("LR-2")).toBeInTheDocument();
  });

  it("says No data, in words, for a reading the forecast did not give, and Unknown for its level", () => {
    const blind = withCheckpoint(route, 0, (checkpoint) => ({
      ...checkpoint,
      weather: {
        ...checkpoint.weather,
        wind_mph: null,
        rain_in_hr: null,
        snow_in_hr: null,
        gust_mph: null,
        temperature_f: null,
      },
      risk: { ...checkpoint.risk, level: null, factors: { wind: null, rain: null, snow: null } },
    }));

    render(<CheckpointTable route={blind} />);

    const first = at(rows(), 0);
    expect(within(first).getAllByText("No data")).toHaveLength(5);
    expect(within(first).getAllByText("Unknown")).toHaveLength(4);
  });

  it("sorts by distance, farthest first on the second press", async () => {
    const user = userEvent.setup();
    render(<CheckpointTable route={route} />);

    await user.click(screen.getByRole("columnheader", { name: /Distance/u }));
    await user.click(screen.getByRole("columnheader", { name: /Distance/u }));

    expect(at(indexes(), 0)).toBe(String(route.checkpoints.length - 1));
    expect(screen.getByRole("columnheader", { name: /Distance/u })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });

  it("sorts by level by severity, never by the alphabet, with Unknown last in both directions", async () => {
    const mixed = withCheckpoint(
      withCheckpoint(route, 0, (c) => ({ ...c, risk: { ...c.risk, level: "high" } })),
      1,
      (c) => ({ ...c, risk: { ...c.risk, level: null } }),
    );
    const user = userEvent.setup();
    render(<CheckpointTable route={mixed} />);
    const levelHeader = screen.getByRole("columnheader", { name: /Level/u });

    await user.click(levelHeader);
    const ascending = indexes();
    await user.click(levelHeader);
    const descending = indexes();

    expect(at(ascending, ascending.length - 1)).toBe("1");
    expect(at(descending, descending.length - 1)).toBe("1");
    expect(at(descending, 0)).toBe("0");
  });

  it.each(["ETA", "Wind", "Rain", "Snow"])("can sort by %s", async (name) => {
    const user = userEvent.setup();
    render(<CheckpointTable route={route} />);

    await user.click(screen.getByRole("columnheader", { name: new RegExp(name, "u") }));

    expect(screen.getByRole("columnheader", { name: new RegExp(name, "u") })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });

  it("does not offer sorting on the columns that cannot be sorted", () => {
    render(<CheckpointTable route={route} />);

    for (const name of [/Gust/u, /Temp/u, /Load rule/u]) {
      expect(screen.getByRole("columnheader", { name })).not.toHaveAttribute("aria-sort");
    }
  });

  it("starts sorted by # ascending and says so: aria-sort and an up arrow on that header (R3-28)", () => {
    render(<CheckpointTable route={route} />);

    const index = screen.getByRole("columnheader", { name: "#" });
    expect(index).toHaveAttribute("aria-sort", "ascending");
    expect(index.querySelector("svg")).toHaveClass("lucide-arrow-up");
    expect(screen.getByRole("columnheader", { name: /Distance/u })).toHaveAttribute(
      "aria-sort",
      "none",
    );
    expect(indexes()).toEqual(["0", "1", "2", "3", "4", "5"]);
  });

  it("sorts by #, last checkpoint first on a press, and brings the order back after another sort (R3-28)", async () => {
    const user = userEvent.setup();
    render(<CheckpointTable route={route} />);
    const index = screen.getByRole("columnheader", { name: "#" });

    await user.click(index);
    expect(index).toHaveAttribute("aria-sort", "descending");
    expect(indexes()).toEqual(["5", "4", "3", "2", "1", "0"]);

    await user.click(screen.getByRole("columnheader", { name: /Wind/u }));
    await user.click(index);
    expect(index).toHaveAttribute("aria-sort", "ascending");
    expect(indexes()).toEqual(["0", "1", "2", "3", "4", "5"]);
  });

  it("selects the checkpoint of a row that is pressed, in the shared trip state", async () => {
    render(<CheckpointTable route={route} />);

    await userEvent.setup().click(at(rows(), 2));

    expect(tripStore.getState().hoveredCheckpoint).toEqual({ routeId: route.route_id, index: 2 });
    expect(at(rows(), 2)).toHaveAttribute("aria-selected", "true");
  });

  it("clears the shared checkpoint when the selection is cleared with Escape", async () => {
    const user = userEvent.setup();
    render(<CheckpointTable route={route} />);
    await user.click(at(rows(), 2));

    await user.keyboard("{Escape}");

    expect(tripStore.getState().hoveredCheckpoint).toBeNull();
  });

  it("shows the row of the checkpoint hovered on the map or the profile as selected", () => {
    render(<CheckpointTable route={route} />);

    act(() => {
      tripStore.actions.hoverCheckpoint({ routeId: route.route_id, index: 3 });
    });

    expect(at(rows(), 3)).toHaveAttribute("aria-selected", "true");
    expect(at(rows(), 2)).toHaveAttribute("aria-selected", "false");
  });

  it("ignores a checkpoint hovered on another route", () => {
    render(<CheckpointTable route={route} />);

    act(() => {
      tripStore.actions.hoverCheckpoint({ routeId: "Z", index: 3 });
    });

    expect(rows().every((row) => row.getAttribute("aria-selected") !== "true")).toBe(true);
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<CheckpointTable route={route} />);

    await expectNoAxeViolations(container);
  });
});
