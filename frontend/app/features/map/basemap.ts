/**
 * The OpenFreeMap basemaps and the few paint overrides that make them legible under our data
 * (DESIGN.md section 9.1), plus where our layers slot into a style's layer stack (section 9.2).
 */
import type { ResolvedTheme } from "../../design-system/foundation/theme";
import { palette } from "./symbology";

/** The part of a style layer the anchors and overrides look at. */
export interface StyleLayerInfo {
  readonly id: string;
  readonly type: string;
  readonly "source-layer"?: string;
}

/** A paint property to set on a basemap layer after each style load. */
export interface BasemapOverride {
  readonly layer: string;
  readonly property: "line-color" | "text-color" | "text-halo-color";
  readonly value: string;
}

/** OpenFreeMap style of a theme: Positron (light), Dark (dark). */
export function basemapStyleUrl(theme: ResolvedTheme): string {
  return palette(theme)["map-basemap-style-url"];
}

/**
 * The layer the heatmap is inserted before: the first one that draws roads, aeroways or labels, so
 * those stay on top of the field. `undefined` appends it.
 */
export function heatmapBeforeId(layers: readonly StyleLayerInfo[]): string | undefined {
  return layers.find(
    (layer) =>
      layer.type === "symbol" ||
      layer["source-layer"] === "transportation" ||
      layer["source-layer"] === "aeroway",
  )?.id;
}

/** The first label layer: routes go under it so city names stay readable. */
export function firstSymbolLayerId(layers: readonly StyleLayerInfo[]): string | undefined {
  return layers.find((layer) => layer.type === "symbol")?.id;
}

const LIGHT_CASINGS = new Set(["highway_motorway_casing", "highway_motorway_bridge_casing"]);
const LIGHT_WATER_LABELS = new Set(["water_name_point_label", "water_name_line_label"]);
const DARK_LABEL_PREFIXES = ["place_", "highway_name_", "water_name"] as const;

/** The overrides for the layers a style actually has. */
export function basemapOverrides(
  theme: ResolvedTheme,
  layers: readonly StyleLayerInfo[],
): BasemapOverride[] {
  const p = palette(theme);
  if (theme === "light") {
    return [
      ...layers
        .filter((layer) => LIGHT_CASINGS.has(layer.id))
        .map((layer): BasemapOverride => ({
          layer: layer.id,
          property: "line-color",
          value: p["map-basemap-motorway-casing-override"],
        })),
      ...layers
        .filter((layer) => LIGHT_WATER_LABELS.has(layer.id))
        .map((layer): BasemapOverride => ({
          layer: layer.id,
          property: "text-color",
          value: p["map-basemap-label-override"],
        })),
    ];
  }
  return layers.flatMap((layer): BasemapOverride[] => {
    if (layer.id === "highway_motorway_inner") {
      return [
        {
          layer: layer.id,
          property: "line-color",
          value: p["map-basemap-motorway-inner-override"],
        },
      ];
    }
    if (layer.id === "highway_motorway_casing") {
      return [
        {
          layer: layer.id,
          property: "line-color",
          value: p["map-basemap-motorway-casing-override"],
        },
      ];
    }
    if (
      layer.type === "symbol" &&
      DARK_LABEL_PREFIXES.some((prefix) => layer.id.startsWith(prefix))
    ) {
      return [
        { layer: layer.id, property: "text-color", value: p["map-basemap-label-override"] },
        {
          layer: layer.id,
          property: "text-halo-color",
          value: p["map-basemap-label-halo-override"],
        },
      ];
    }
    return [];
  });
}
