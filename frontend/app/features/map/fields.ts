/** The heatmap layers the dock's switch offers, with their labels (microcopy `timeline.fields`). */
import { t } from "../../design-system/foundation/strings";
import type { HeatmapLayer } from "../../state/trip-store";
import { HEATMAP_LAYERS } from "./heatmap";

/** One item of the layer switch. */
export interface FieldItem {
  readonly id: HeatmapLayer;
  readonly label: string;
}

const LABEL_KEY = {
  risk: "timeline.fields.risk",
  wind_mph: "timeline.fields.wind",
  rain_in_hr: "timeline.fields.rain",
  snow_in_hr: "timeline.fields.snow",
} as const satisfies Record<HeatmapLayer, string>;

/** The switch's items: Risk, Wind, Rain, Snow. */
export function fieldItems(): FieldItem[] {
  return HEATMAP_LAYERS.map((id) => ({ id, label: t(LABEL_KEY[id]) }));
}

/**
 * The heatmap layer an item id names.
 *
 * @throws {RangeError} for an id that is not a layer (only a programming error can produce one).
 */
export function toHeatmapLayer(id: string): HeatmapLayer {
  const layer = HEATMAP_LAYERS.find((candidate) => candidate === id);
  if (layer === undefined) throw new RangeError(`"${id}" is not a heatmap layer`);
  return layer;
}
