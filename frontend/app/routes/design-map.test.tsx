import { render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeMaps, resetFakes } from "../../test/fake-maplibre";
import { installMatchMedia } from "../../test/match-media";
import { ThemeProvider } from "../design-system/foundation/ThemeProvider";
import { tokens } from "../design-system/tokens/tokens";
import { at } from "../lib/checked";
import DesignMap, { HARNESS_REQUEST, blankBasemap, meta } from "./design-map";

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

beforeEach(() => {
  resetFakes();
  installMatchMedia();
  vi.stubGlobal("ResizeObserver", InertResizeObserver);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function open(path: string): Promise<void> {
  const Stub = createRoutesStub([{ path: "/design/map", Component: DesignMap }]);
  render(
    <ThemeProvider>
      <Stub initialEntries={[path]} />
    </ThemeProvider>,
  );
  await screen.findByTestId("map-canvas-container");
}

describe("/design/map", () => {
  it("draws the fixture trip on the OpenFreeMap basemap with its legend and timeline", async () => {
    await open("/design/map");

    expect(screen.getByRole("heading", { level: 1, name: "Map harness" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Forecast time" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Risk level" })).toBeInTheDocument();
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
