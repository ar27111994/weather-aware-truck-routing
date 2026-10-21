import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { NullableRiskLevel, Route } from "../../api/contract";
import { at } from "../../lib/checked";
import { expectNoAxeViolations, warmUpAxe } from "../../../test/axe";
import { planFor } from "../../../test/plans";
import { tripStore } from "../../state";
import { RiskProfileChart } from "./RiskProfileChart";

const route = at(planFor("mixed").routes, 0);

beforeAll(async () => {
  await warmUpAxe();
}, 60_000);

beforeEach(() => {
  act(() => {
    tripStore.actions.hoverCheckpoint(null);
  });
});

function options(): HTMLElement[] {
  return screen.getAllByRole("option");
}

function hovered(): number | undefined {
  return tripStore.getState().hoveredCheckpoint?.index;
}

/** A route whose checkpoints take the given levels in order (the rest keep their own). */
function withLevels(levels: readonly NullableRiskLevel[]): Route {
  return {
    ...route,
    checkpoints: route.checkpoints.map((checkpoint, index) => {
      if (index >= levels.length) return checkpoint;
      return { ...checkpoint, risk: { ...checkpoint.risk, level: levels[index] ?? null } };
    }),
  };
}

describe("RiskProfileChart", () => {
  it("is a listbox named for the route, with one option per checkpoint", () => {
    render(<RiskProfileChart route={route} />);

    expect(
      screen.getByRole("listbox", { name: `Risk along Route ${route.route_id}` }),
    ).toBeInTheDocument();
    expect(options()).toHaveLength(route.checkpoints.length);
  });

  it("names each checkpoint by its number, distance, level and ETA", () => {
    render(<RiskProfileChart route={route} />);

    expect(at(options(), 0)).toHaveAccessibleName(
      /^Checkpoint 0, 0\.0 miles, (Low|Moderate|High|Severe|No Travel|Unknown), ETA Tue 8:00 AM MDT$/u,
    );
  });

  it("describes the profile: the route, the miles at each level and where the highest level is", () => {
    render(<RiskProfileChart route={route} />);

    const description = document.querySelector("desc");
    expect(description?.textContent).toMatch(
      new RegExp(`^Route ${route.route_id}: .+\\. Highest level \\w+ at mile [\\d,.]+\\.$`, "u"),
    );
    expect(screen.getByRole("listbox")).toHaveAccessibleDescription(/Route .+ Highest level/u);
  });

  it("describes miles without weather as Unknown", () => {
    const blind = { ...route, stats: { ...route.stats, unknown_mi: 12.5 } };

    render(<RiskProfileChart route={blind} />);

    expect(document.querySelector("desc")?.textContent).toContain("Unknown 12.5 mi");
  });

  it("falls back to mile 0 when no checkpoint carries the route's highest level", () => {
    const odd = { ...route, stats: { ...route.stats, max_level: "no_travel" as const } };
    const calm = withLevels(route.checkpoints.map(() => "low" as const));

    render(<RiskProfileChart route={{ ...calm, stats: odd.stats }} />);

    expect(document.querySelector("desc")?.textContent).toContain(
      "Highest level No Travel at mile 0.0.",
    );
  });

  it("points to the Checkpoints tab for every value, and says how to move while nothing is active", () => {
    render(<RiskProfileChart route={route} />);

    expect(
      screen.getByText(
        "Arrow keys move between checkpoints. Home and End jump to the first and last.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("The same values are in the Checkpoints tab.")).toBeInTheDocument();
  });

  it("draws each level as its own shape: circle, diamond, triangle, square, octagon, dashed ring", () => {
    const levels: NullableRiskLevel[] = ["low", "moderate", "high", "severe", "no_travel", null];
    render(<RiskProfileChart route={withLevels(levels)} />);

    const shapes = options()
      .slice(0, levels.length)
      .map((option) => {
        const shape = option.firstElementChild;
        return `${shape?.tagName.toLowerCase() ?? "none"}${shape?.hasAttribute("stroke-dasharray") === true ? "-dashed" : ""}`;
      });
    expect(shapes).toEqual(["circle", "path", "path", "rect", "path", "circle-dashed"]);
  });

  it("takes the first checkpoint on focus and shares it with the map and the table", async () => {
    const user = userEvent.setup();
    render(<RiskProfileChart route={route} />);

    await user.tab();

    expect(screen.getByRole("listbox")).toHaveFocus();
    expect(hovered()).toBe(0);
    expect(at(options(), 0)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("listbox")).toHaveAttribute(
      "aria-activedescendant",
      at(options(), 0).id,
    );
  });

  it("moves between checkpoints with the arrow keys and stops at both ends", async () => {
    const user = userEvent.setup();
    render(<RiskProfileChart route={route} />);
    await user.tab();

    await user.keyboard("{ArrowLeft}");
    expect(hovered()).toBe(0);
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(hovered()).toBe(2);
    await user.keyboard("{ArrowDown}");
    expect(hovered()).toBe(3);
    await user.keyboard("{ArrowUp}");
    expect(hovered()).toBe(2);
    await user.keyboard("{End}");
    expect(hovered()).toBe(route.checkpoints.length - 1);
    await user.keyboard("{ArrowRight}");
    expect(hovered()).toBe(route.checkpoints.length - 1);
    await user.keyboard("{Home}");
    expect(hovered()).toBe(0);
  });

  it("ignores keys it does not use, so Tab still leaves the chart", async () => {
    const user = userEvent.setup();
    render(<RiskProfileChart route={route} />);
    await user.tab();

    await user.keyboard("a");
    expect(hovered()).toBe(0);
    await user.tab();

    expect(screen.getByRole("listbox")).not.toHaveFocus();
  });

  it("lets go of the shared checkpoint when focus leaves", async () => {
    const user = userEvent.setup();
    render(<RiskProfileChart route={route} />);
    await user.tab();
    expect(hovered()).toBe(0);

    await user.tab();

    expect(hovered()).toBeUndefined();
  });

  it("copes with the shared checkpoint being cleared elsewhere while it has focus", async () => {
    const user = userEvent.setup();
    render(<RiskProfileChart route={route} />);
    await user.tab();

    act(() => {
      tripStore.actions.hoverCheckpoint(null);
    });
    await user.tab();

    expect(hovered()).toBeUndefined();
  });

  it("keeps the checkpoint already shared when it takes focus", async () => {
    const user = userEvent.setup();
    render(<RiskProfileChart route={route} />);
    act(() => {
      tripStore.actions.hoverCheckpoint({ routeId: route.route_id, index: 4 });
    });

    await user.tab();

    expect(hovered()).toBe(4);
  });

  it("shares the checkpoint under the pointer, and lets go when the pointer leaves", async () => {
    const user = userEvent.setup();
    render(<RiskProfileChart route={route} />);

    await user.hover(at(options(), 3));
    expect(tripStore.getState().hoveredCheckpoint).toEqual({ routeId: route.route_id, index: 3 });
    expect(at(options(), 3)).toHaveAttribute("aria-selected", "true");

    await user.unhover(at(options(), 3));
    expect(hovered()).toBeUndefined();
  });

  it("reads the active checkpoint out under the chart, as its option name", () => {
    render(<RiskProfileChart route={route} />);

    act(() => {
      tripStore.actions.hoverCheckpoint({ routeId: route.route_id, index: 2 });
    });

    expect(
      screen.getAllByText(at(options(), 2).getAttribute("aria-label") ?? "").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/^Arrow keys move/u)).not.toBeInTheDocument();
  });

  it("ignores a checkpoint hovered on another route or past the end of this one", () => {
    render(<RiskProfileChart route={route} />);

    act(() => {
      tripStore.actions.hoverCheckpoint({ routeId: "Z", index: 1 });
    });
    expect(options().every((option) => option.getAttribute("aria-selected") === "false")).toBe(
      true,
    );

    act(() => {
      tripStore.actions.hoverCheckpoint({
        routeId: route.route_id,
        index: route.checkpoints.length + 5,
      });
    });
    expect(options().every((option) => option.getAttribute("aria-selected") === "false")).toBe(
      true,
    );
    expect(screen.getByRole("listbox")).not.toHaveAttribute("aria-activedescendant");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<RiskProfileChart route={route} />);

    await expectNoAxeViolations(container);
  });
});
