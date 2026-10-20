/**
 * The corridor forecast field (R7) the way DESIGN.md section 9.8 and D-11 draw it: one polygon per
 * grid cell, added once, coloured per frame through `feature-state`. Nothing is interpolated or
 * smoothed: a cell shows the value the forecast gives for its centre ("honest data").
 */
import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { ExpressionSpecification } from "maplibre-gl";

import type { Heatmap, HeatmapGrid, RiskLevel, RiskRules } from "../../api/contract";
import type { ResolvedTheme } from "../../design-system/foundation/theme";
import { RISK_RULES } from "../../lib/risk";
import type { HeatmapLayer } from "../../state/trip-store";
import { palette, riskFill } from "./symbology";

/** The layers the field switch offers, in its order (DESIGN.md section 9.10). */
export const HEATMAP_LAYERS = [
  "risk",
  "wind_mph",
  "rain_in_hr",
  "snow_in_hr",
] as const satisfies readonly HeatmapLayer[];

/** A missing forecast value (`null` in the API, `-1` in `risk`): drawn as Unknown, never as calm. */
export const UNKNOWN_VALUE = -1;

/** The value a cell reads before any frame has been written to it: not drawn at all. */
export const NOT_SET = -2;

/** A weather layer: the three fields with a colour ramp. */
export type WeatherLayer = Exclude<HeatmapLayer, "risk">;

/** The five stops of a weather layer: the display floor, then where Moderate..No Travel start. */
export type FieldStops = readonly [number, number, number, number, number];

const FACTOR = { wind_mph: "wind", rain_in_hr: "rain", snow_in_hr: "snow" } as const;

/** Decimals the legend prints for each weather layer's thresholds (DESIGN.md section 9.9). */
const TICK_DIGITS = { wind_mph: 0, rain_in_hr: 2, snow_in_hr: 1 } as const;

/** Feature-state value of a cell, `NOT_SET` before the first frame is written. */
const V: ExpressionSpecification = ["coalesce", ["feature-state", "v"], NOT_SET];

/** Cell polygons: the corners of cell `index` per D-22; the feature id is the cell index. */
export function buildCellCollection(
  grid: HeatmapGrid,
  cells: readonly number[],
): FeatureCollection<Polygon> {
  const features = cells.map((index): Feature<Polygon> => {
    const row = Math.floor(index / grid.cols);
    const col = index % grid.cols;
    const south = grid.lat0 + row * grid.dlat;
    const north = grid.lat0 + (row + 1) * grid.dlat;
    const west = grid.lon0 + col * grid.dlon;
    const east = grid.lon0 + (col + 1) * grid.dlon;
    return {
      type: "Feature",
      id: index,
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
          ],
        ],
      },
      properties: {},
    };
  });
  return { type: "FeatureCollection", features };
}

/** All 49 frames of every layer, in memory before the slider enables. */
export interface HeatmapFrames {
  /** Grid index of each cell, in the order of every frame's values. */
  readonly cellIds: Int32Array;
  readonly frameCount: number;
  /** Instant of frame 0 (`start_time`), in milliseconds since the epoch. */
  readonly startTime: number;
  /** Risk ordinals 0..4, {@link UNKNOWN_VALUE} where unknown. */
  readonly risk: Int8Array;
  /**
   * Weather values, {@link UNKNOWN_VALUE} where missing. 64-bit on purpose: a 32-bit float rounds
   * 3.001 in/hr of snow down below the No Travel edge, so the cell would show the wrong band.
   */
  readonly wind_mph: Float64Array;
  readonly rain_in_hr: Float64Array;
  readonly snow_in_hr: Float64Array;
  /**
   * The values of `layer` at `frame`, one per cell, as a view into the decoded array (no copy).
   *
   * @throws {RangeError} unless `frame` is an integer in `0..frameCount - 1`.
   */
  frame: (layer: HeatmapLayer, frame: number) => Int8Array | Float64Array;
}

const decoded = new WeakMap<Heatmap, HeatmapFrames>();

function weather(values: readonly (number | null)[]): Float64Array {
  return Float64Array.from(values, (value) => value ?? UNKNOWN_VALUE);
}

/**
 * Decodes a heatmap's frame-major arrays into typed arrays, once per heatmap object (a second call
 * with the same object returns the same frames, so the map and the timeline share one decode).
 */
export function decodeHeatmap(heatmap: Heatmap): HeatmapFrames {
  const cached = decoded.get(heatmap);
  if (cached) return cached;
  const cellCount = heatmap.cells.length;
  const layers = {
    risk: Int8Array.from(heatmap.fields.risk),
    wind_mph: weather(heatmap.fields.wind_mph),
    rain_in_hr: weather(heatmap.fields.rain_in_hr),
    snow_in_hr: weather(heatmap.fields.snow_in_hr),
  };
  const frames: HeatmapFrames = {
    cellIds: Int32Array.from(heatmap.cells),
    frameCount: heatmap.frame_count,
    startTime: Date.parse(heatmap.start_time),
    ...layers,
    frame: (layer, frame) => {
      if (!Number.isInteger(frame) || frame < 0 || frame >= heatmap.frame_count) {
        throw new RangeError(
          `Frame ${String(frame)} is outside 0..${String(heatmap.frame_count - 1)}`,
        );
      }
      return layers[layer].subarray(frame * cellCount, (frame + 1) * cellCount);
    },
  };
  decoded.set(heatmap, frames);
  return frames;
}

/**
 * Positions whose value differs between two frames (every position when there is no previous
 * frame), so a frame change writes feature-state only where the forecast changed.
 */
export function frameChanges(
  previous: Int8Array | Float64Array | undefined,
  next: Int8Array | Float64Array,
): number[] {
  const changed: number[] = [];
  for (let position = 0; position < next.length; position += 1) {
    if (previous?.[position] !== next[position]) changed.push(position);
  }
  return changed;
}

/** Where a level's band starts, as the rules write it. */
interface BandStart {
  readonly edge: number;
  readonly inclusive: boolean;
}

/**
 * Where `level`'s band of a factor starts.
 *
 * @throws {RangeError} when the rules have no such band or it has no lower edge (a rules file that
 *   breaks the ladder must fail loudly instead of shading cells with a wrong bin).
 */
function bandStart(rules: RiskRules, layer: WeatherLayer, level: RiskLevel): BandStart {
  const band = rules.factors[FACTOR[layer]].bands.find((candidate) => candidate.level === level);
  if (band?.min_inclusive !== undefined) return { edge: band.min_inclusive, inclusive: true };
  if (band?.min_exclusive !== undefined) return { edge: band.min_exclusive, inclusive: false };
  throw new RangeError(`The ${FACTOR[layer]} rules give ${level} no lower edge`);
}

/** The display floor and the starts of the Moderate, High, Severe and No Travel bands. */
function bandStarts(
  layer: WeatherLayer,
  rules: RiskRules,
): readonly [number, BandStart, BandStart, BandStart, BandStart] {
  return [
    palette("light")[`heatmap-display-floor-${FACTOR[layer]}`],
    bandStart(rules, layer, "moderate"),
    bandStart(rules, layer, "high"),
    bandStart(rules, layer, "severe"),
    bandStart(rules, layer, "no_travel"),
  ];
}

/**
 * The lower edge of each of the five shaded bins of a weather layer: the display floor, then the
 * Moderate to No Travel band edges from the rules. `step` stops are lower-inclusive (D-01), so an
 * edge the rules make exclusive (`min_exclusive`: the upper-inclusive Severe bands of rain and snow)
 * moves up by the field's precision: 1.000 in/hr of rain stays Severe, 1.001 is No Travel.
 */
export function fieldStops(layer: WeatherLayer, rules: RiskRules = RISK_RULES): FieldStops {
  const { precision } = rules.factors[FACTOR[layer]];
  const scale = Math.round(1 / precision);
  const stop = (start: BandStart): number =>
    start.inclusive ? start.edge : Math.round((start.edge + precision) * scale) / scale;
  const [floor, moderate, high, severe, noTravel] = bandStarts(layer, rules);
  return [floor, stop(moderate), stop(high), stop(severe), stop(noTravel)];
}

/** The threshold printed under each of the five legend steps: the band edges as the rules write them. */
export function legendTicks(
  layer: WeatherLayer,
  rules: RiskRules = RISK_RULES,
): readonly [string, string, string, string, string] {
  const format = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: TICK_DIGITS[layer],
    maximumFractionDigits: 2,
  });
  const [floor, moderate, high, severe, noTravel] = bandStarts(layer, rules);
  return [
    format.format(floor),
    format.format(moderate.edge),
    format.format(high.edge),
    format.format(severe.edge),
    format.format(noTravel.edge),
  ];
}

/** `fill-color` and `fill-opacity` of the heatmap layer for one layer of the switch. */
export interface HeatmapPaint {
  readonly "fill-color": ExpressionSpecification;
  readonly "fill-opacity": ExpressionSpecification;
}

/**
 * Paint of the cell layer (DESIGN.md section 9.8). Changing layer is a `setPaintProperty` on the
 * same layer; the data never changes.
 */
export function heatmapPaint(
  layer: HeatmapLayer,
  theme: ResolvedTheme,
  rules: RiskRules = RISK_RULES,
): HeatmapPaint {
  const p = palette(theme);
  const unknown = riskFill(theme, "unknown");
  if (layer === "risk") {
    return {
      "fill-color": [
        "step",
        V,
        unknown,
        0,
        riskFill(theme, "low"),
        1,
        riskFill(theme, "moderate"),
        2,
        riskFill(theme, "high"),
        3,
        riskFill(theme, "severe"),
        4,
        riskFill(theme, "no_travel"),
      ],
      "fill-opacity": [
        "case",
        ["<", V, UNKNOWN_VALUE],
        0,
        ["==", V, 0],
        p["heatmap-risk-opacity-low"],
        p["heatmap-risk-opacity"],
      ],
    };
  }
  const factor = FACTOR[layer];
  const [floor, second, third, fourth, fifth] = fieldStops(layer, rules);
  return {
    // Below 0 is Unknown; from 0, bin 1 (hidden under the floor by the opacity); then a bin per edge.
    "fill-color": [
      "step",
      V,
      unknown,
      0,
      p[`heatmap-${factor}-bin-1`],
      second,
      p[`heatmap-${factor}-bin-2`],
      third,
      p[`heatmap-${factor}-bin-3`],
      fourth,
      p[`heatmap-${factor}-bin-4`],
      fifth,
      p[`heatmap-${factor}-bin-5`],
    ],
    "fill-opacity": [
      "case",
      ["<", V, UNKNOWN_VALUE],
      0,
      ["<", V, 0],
      p["heatmap-risk-opacity-low"],
      ["<", V, floor],
      0,
      p["heatmap-opacity"],
    ],
  };
}
