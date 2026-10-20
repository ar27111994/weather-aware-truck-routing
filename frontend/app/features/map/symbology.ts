/**
 * Paint and layout values of every Haulcast map layer (DESIGN.md section 9), built from the resolved
 * design tokens. MapLibre cannot read CSS custom properties, so the literals come from `tokens.ts`,
 * which is generated from the same `tokens.json` as the CSS; nothing here writes a colour by hand.
 */
import type { DataDrivenPropertyValueSpecification, ExpressionSpecification } from "maplibre-gl";

import type { RiskKey } from "../../design-system/foundation/risk";
import type { ResolvedTheme } from "../../design-system/foundation/theme";
import { tokens } from "../../design-system/tokens/tokens";

/** The six levels a map feature can carry, Unknown last (the `level` property of our features). */
export const MAP_RISK_KEYS = ["low", "moderate", "high", "severe", "no_travel", "unknown"] as const;

/** Token segment of each level (`no-travel` in `risk-no-travel-fill`). */
const RISK_TOKEN = {
  low: "low",
  moderate: "moderate",
  high: "high",
  severe: "severe",
  no_travel: "no-travel",
  unknown: "unknown",
} as const satisfies Record<RiskKey, string>;

/**
 * Gap of the Unknown dash pattern, in line widths. DESIGN.md section 9.4 fixes the pattern at
 * `[1.4, 1.1]`; the token carries the dash (1.4) and its description names this gap.
 */
const UNKNOWN_DASH_GAP = 1.1;

/** Zoom levels the line widths are given at (DESIGN.md section 9.3). */
const WIDTH_STOPS = [4, 8, 12] as const;

type Palette = (typeof tokens)[ResolvedTheme];

/** The token table of a theme. */
export function palette(theme: ResolvedTheme): Palette {
  return tokens[theme];
}

/**
 * A pixel token (`"4px"`) as a number.
 *
 * @throws {RangeError} when the token is not a pixel length; a token that changes unit must fail
 *   loudly rather than draw a wrong width.
 */
export function px(value: string): number {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (match?.[1] === undefined) throw new RangeError(`Expected a px length, got "${value}"`);
  return Number(match[1]);
}

/** Fill colour of a risk level in a theme. */
export function riskFill(theme: ResolvedTheme, key: RiskKey): string {
  return palette(theme)[`risk-${RISK_TOKEN[key]}-fill`];
}

/** Outline (stroke) colour of a risk level's marker in a theme. */
export function riskStroke(theme: ResolvedTheme, key: RiskKey): string {
  return palette(theme)[`risk-${RISK_TOKEN[key]}-stroke`];
}

/** Colour of the marker glyph (the No Travel bar, the Unknown `?`) in a theme. */
export function riskOnFill(theme: ResolvedTheme, key: RiskKey): string {
  return palette(theme)[`risk-${RISK_TOKEN[key]}-on-fill`];
}

/** Line widths at z4, z8 and z12 for the selected route and for the others. */
export interface RouteWidths {
  readonly ribbon: readonly [number, number, number];
  readonly casing: readonly [number, number, number];
  /** Ink outline of the selected route; the others have none. */
  readonly outline: readonly [number, number, number];
}

/** The widths of a selected or an unselected route (DESIGN.md section 9.3). */
export function routeWidths(selected: boolean): RouteWidths {
  const t = palette("light");
  const kind = selected ? "selected" : "unselected";
  const ribbon = [
    px(t[`c-map-route-${kind}-ribbon-z4`]),
    px(t[`c-map-route-${kind}-ribbon-z8`]),
    px(t[`c-map-route-${kind}-ribbon-z12`]),
  ] as const;
  const casingExtra = px(t["c-map-route-casing-extra"]);
  const outlineExtra = px(t["c-map-route-outline-extra"]);
  const casing = [
    ribbon[0] + casingExtra,
    ribbon[1] + casingExtra,
    ribbon[2] + casingExtra,
  ] as const;
  const outline = [
    casing[0] + outlineExtra,
    casing[1] + outlineExtra,
    casing[2] + outlineExtra,
  ] as const;
  return { ribbon, casing, outline };
}

/** `["interpolate", ["linear"], ["zoom"], 4, w4, 8, w8, 12, w12]`. */
export function zoomWidth(
  widths: readonly [number, number, number],
  extra: number | ExpressionSpecification = 0,
): ExpressionSpecification {
  const at = (width: number): number | ExpressionSpecification =>
    typeof extra === "number" ? width + extra : ["+", width, extra];
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    WIDTH_STOPS[0],
    at(widths[0]),
    WIDTH_STOPS[1],
    at(widths[1]),
    WIDTH_STOPS[2],
    at(widths[2]),
  ];
}

/** Extra width while the pointer rests on a route (`hover` feature-state), DESIGN.md section 9.3. */
export function hoverExtra(): ExpressionSpecification {
  return [
    "case",
    ["boolean", ["feature-state", "hover"], false],
    px(palette("light")["c-map-route-hover-ribbon-extra"]),
    0,
  ];
}

/** `line-color` of the risk ribbon: a `match` on the `level` property, Unknown as the fallback. */
export function ribbonColor(theme: ResolvedTheme): ExpressionSpecification {
  return [
    "match",
    ["get", "level"],
    "low",
    riskFill(theme, "low"),
    "moderate",
    riskFill(theme, "moderate"),
    "high",
    riskFill(theme, "high"),
    "severe",
    riskFill(theme, "severe"),
    "no_travel",
    riskFill(theme, "no_travel"),
    riskFill(theme, "unknown"),
  ];
}

/** Dash pattern reserved for Unknown stretches (nothing else on the map is dashed). */
export function unknownDash(): [number, number] {
  return [palette("light")["c-map-route-unknown-dasharray"], UNKNOWN_DASH_GAP];
}

/** Opacity of a route that is not selected. */
export function unselectedOpacity(): number {
  return palette("light")["c-map-route-unselected-opacity"];
}

/** Zoom from which checkpoint ETA labels show. */
export function labelMinZoom(): number {
  return palette("light")["c-map-marker-label-min-zoom"];
}

/** Scale of a highlighted (hovered, focused or open) checkpoint marker. */
export function activeMarkerScale(): number {
  return palette("light")["c-map-marker-selected-scale"];
}

/** `icon-image` of a checkpoint: `hc-cp-<level>` from its `level` property. */
export const CHECKPOINT_ICON: ExpressionSpecification = ["concat", "hc-cp-", ["get", "level"]];

/** Draw order of checkpoints: the `ordinal` property (No Travel on top, Unknown underneath). */
export const CHECKPOINT_SORT_KEY: DataDrivenPropertyValueSpecification<number> = ["get", "ordinal"];

/** Scale of the markers of routes that are not selected (D-14: muted and smaller). */
export const UNSELECTED_MARKER_SCALE = 0.72;

/** Opacity of the markers of routes that are not selected (D-14). */
export const UNSELECTED_MARKER_OPACITY = 0.8;
