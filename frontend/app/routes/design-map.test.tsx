import { render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeMaps, resetFakes } from "../../test/fake-maplibre";
import { installMatchMedia } from "../../test/match-media";
import { ThemeProvider } from "../design-system/foundation/ThemeProvider";
import { tokens } from "../design-system/tokens/tokens";
import { DEFAULT_PADDING } from "../features/map";
import { at } from "../lib/checked";
import DesignMap, { HARNESS_GLOBAL, HARNESS_REQUEST, blankBasemap, meta } from "./design-map";

vi.mock("maplibre-gl", () => import("../../test/fake-maplibre"));

class InertResizeObserver {
  observe(): void {
    return undefined;
  }

  unobserve(): void {
    return undefined;
  }

  disconnect(): void {
    return undefined;
  }
}

// `MapView` is lazy. Its first import (the whole map module graph) can outlast a `findBy` wait on a
// busy machine, so it happens once here, outside every test's timeout.
beforeAll(async () => {
  await import("../features/map/MapView");
}, 60_000);

beforeEach(() => {
  resetFakes();
  installMatchMedia();
  vi.stubGlobal("ResizeObserver", InertResizeObserver);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function open(path: string): Promise<() => void> {
  const Stub = createRoutesStub([{ path: "/design/map", Component: DesignMap }]);
  const { unmount } = render(
    <ThemeProvider>
      <Stub initialEntries={[path]} />
    </ThemeProvider>,
  );
  await screen.findByTestId("map-canvas-container");
  return unmount;
}

describe("/design/map", () => {
  it("draws the fixture trip on the OpenFreeMap basemap with its legend and timeline", async () => {
    await open("/design/map");

    expect(screen.getByRole("heading", { level: 1, name: "Map harness" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Forecast time" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Legend" })).toBeInTheDocument();
    expect(at(fakeMaps, 0).styleUrl).toBe(tokens.light["map-basemap-style-url"]);
    expect(HARNESS_REQUEST.scenario).toBe("severe-on-fastest");
  });

  it("uses the blank basemap for visual goldens", async () => {
    await open("/design/map?basemap=blank");

    expect(at(fakeMaps, 0).styleUrl).toEqual(blankBasemap("light"));
  });

  it("is kept out of search results", () => {
    expect(meta()).toContainEqual({ name: "robots", content: "noindex, nofollow" });
    expect(meta()).toContainEqual({ title: "Map harness" });
  });

  it("hands the live map and the trip store to the R7 probe (window.__hcHarness)", async () => {
    const unmount = await open("/design/map");

    const harness = Reflect.get(window, HARNESS_GLOBAL) as
      | {
          map: unknown;
          store: { getState: () => { sliderFrame: number } };
          padding: unknown;
        }
      | undefined;
    expect(harness?.map).toBe(at(fakeMaps, 0));
    expect(harness?.store.getState().sliderFrame).toBe(0);
    // The padding the trip was framed with, so the sweep can check the camera against the fit.
    expect(harness?.padding).toEqual(DEFAULT_PADDING);

    unmount();
    expect(Reflect.get(window, HARNESS_GLOBAL)).toBeUndefined();
  });
});

describe("/design/map layout (DESIGN.md section 8)", () => {
  const firstFraming = (): unknown => at(fakeMaps, 0).cameraCalls[0]?.args[1];

  it("below 1024 px closes the legend and frames the trip with the map's default padding", async () => {
    await open("/design/map");

    expect(screen.getByRole("button", { name: "Legend" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(firstFraming()).toMatchObject({ padding: DEFAULT_PADDING });
  });

  it("from 1024 px opens the legend and frames the trip clear of it", async () => {
    installMatchMedia({ "(min-width: 1024px)": true });
    await open("/design/map");

    expect(screen.getByRole("button", { name: "Legend" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "Risk level" })).toBeInTheDocument();
    // The legend is 280 px wide and inset 16 px; the trip starts another 16 px to its right.
    expect(firstFraming()).toMatchObject({ padding: { ...DEFAULT_PADDING, left: 312 } });
  });
});

describe("blankBasemap", () => {
  it("is the theme's land colour and nothing else", () => {
    for (const theme of ["light", "dark"] as const) {
      expect(blankBasemap(theme)).toEqual({
        version: 8,
        name: "Blank",
        sources: {},
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": tokens[theme]["map-basemap-land"] },
          },
        ],
      });
    }
  });
});
