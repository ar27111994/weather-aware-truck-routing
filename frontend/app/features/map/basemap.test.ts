import { describe, expect, it } from "vitest";

import { basemapOverrides, basemapStyleUrl, firstSymbolLayerId, heatmapBeforeId } from "./basemap";
import { palette } from "./symbology";

const POSITRON_LIKE = [
  { id: "background", type: "background" },
  { id: "water", type: "fill", "source-layer": "water" },
  { id: "tunnel_motorway_casing", type: "line", "source-layer": "transportation" },
  { id: "highway_motorway_casing", type: "line", "source-layer": "transportation" },
  { id: "highway_motorway_bridge_casing", type: "line", "source-layer": "transportation" },
  { id: "highway_motorway_inner", type: "line", "source-layer": "transportation" },
  { id: "water_name_point_label", type: "symbol", "source-layer": "water_name" },
  { id: "water_name_line_label", type: "symbol", "source-layer": "water_name" },
  { id: "highway_name_motorway", type: "symbol", "source-layer": "transportation_name" },
  { id: "place_city", type: "symbol", "source-layer": "place" },
] as const;

describe("basemapStyleUrl", () => {
  it("is OpenFreeMap Positron in the light theme and Dark in the dark one", () => {
    expect(basemapStyleUrl("light")).toBe("https://tiles.openfreemap.org/styles/positron");
    expect(basemapStyleUrl("dark")).toBe("https://tiles.openfreemap.org/styles/dark");
  });
});

describe("layer anchors (DESIGN.md section 9.2)", () => {
  it("slides the heatmap under the first road, aeroway or label layer, so roads draw over the field", () => {
    expect(heatmapBeforeId(POSITRON_LIKE)).toBe("tunnel_motorway_casing");
    expect(
      heatmapBeforeId([
        { id: "land", type: "fill" },
        { id: "water_name", type: "symbol" },
      ]),
    ).toBe("water_name");
    expect(heatmapBeforeId([{ id: "runway", type: "line", "source-layer": "aeroway" }])).toBe(
      "runway",
    );
  });

  it("puts the routes under the first label layer, so city names stay readable", () => {
    expect(firstSymbolLayerId(POSITRON_LIKE)).toBe("water_name_point_label");
  });

  it("appends on top when a style has no such layer", () => {
    expect(heatmapBeforeId([{ id: "background", type: "background" }])).toBeUndefined();
    expect(firstSymbolLayerId([])).toBeUndefined();
  });
});

describe("basemapOverrides", () => {
  it("greys the blue water labels and darkens the motorway casing in the light theme", () => {
    const light = palette("light");

    expect(basemapOverrides("light", POSITRON_LIKE)).toEqual([
      {
        layer: "highway_motorway_casing",
        property: "line-color",
        value: light["map-basemap-motorway-casing-override"],
      },
      {
        layer: "highway_motorway_bridge_casing",
        property: "line-color",
        value: light["map-basemap-motorway-casing-override"],
      },
      {
        layer: "water_name_point_label",
        property: "text-color",
        value: light["map-basemap-label-override"],
      },
      {
        layer: "water_name_line_label",
        property: "text-color",
        value: light["map-basemap-label-override"],
      },
    ]);
  });

  it("lifts place, road-name and water labels to a readable grey and makes motorways visible in the dark theme", () => {
    const dark = palette("dark");

    const overrides = basemapOverrides("dark", POSITRON_LIKE);

    expect(overrides).toContainEqual({
      layer: "highway_motorway_inner",
      property: "line-color",
      value: dark["map-basemap-motorway-inner-override"],
    });
    expect(overrides).toContainEqual({
      layer: "highway_motorway_casing",
      property: "line-color",
      value: dark["map-basemap-motorway-casing-override"],
    });
    for (const layer of [
      "water_name_point_label",
      "water_name_line_label",
      "highway_name_motorway",
      "place_city",
    ]) {
      expect(overrides).toContainEqual({
        layer,
        property: "text-color",
        value: dark["map-basemap-label-override"],
      });
      expect(overrides).toContainEqual({
        layer,
        property: "text-halo-color",
        value: dark["map-basemap-label-halo-override"],
      });
    }
    // Only symbol layers get label colours.
    expect(overrides.filter((override) => override.layer === "tunnel_motorway_casing")).toEqual([]);
  });
});
