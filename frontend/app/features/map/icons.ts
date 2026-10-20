/**
 * Checkpoint marker images (DESIGN.md sections 4 and 9.5): one per level and theme, drawn on a
 * canvas and registered with `map.addImage` after every style load. Each level has its own shape
 * and size, so a marker never depends on colour alone.
 */
import type { RiskKey } from "../../design-system/foundation/risk";
import type { ResolvedTheme } from "../../design-system/foundation/theme";
import { palette, riskFill, riskOnFill, riskStroke } from "./symbology";

/** Marker size in CSS px per level (DESIGN.md section 4): larger means more dangerous. */
export const MARKER_SIZE = {
  low: 12,
  moderate: 16,
  high: 18,
  severe: 18,
  no_travel: 22,
  unknown: 14,
} as const satisfies Record<RiskKey, number>;

/** Room around the shape for the 2 px stroke and the 1 px ink hairline, both sides. */
export const MARKER_PADDING = 6;

/** Width of the level's stroke and of the ink hairline outside it, in CSS px. */
const STROKE_WIDTH = 2;
const HAIRLINE_WIDTH = 1;

/** The part of `CanvasRenderingContext2D` a marker is drawn with. */
export type MarkerContext = Pick<
  CanvasRenderingContext2D,
  | "fillStyle"
  | "strokeStyle"
  | "lineWidth"
  | "lineJoin"
  | "font"
  | "textAlign"
  | "textBaseline"
  | "scale"
  | "beginPath"
  | "closePath"
  | "moveTo"
  | "lineTo"
  | "arc"
  | "fill"
  | "stroke"
  | "fillRect"
  | "fillText"
  | "setLineDash"
>;

/** The image id the symbol layer's `icon-image` asks for. */
export function markerImageId(key: RiskKey): string {
  return `hc-cp-${key}`;
}

/** Width and height of a marker's canvas in CSS px. */
export function markerCanvasSize(key: RiskKey): number {
  return MARKER_SIZE[key] + MARKER_PADDING;
}

function polygon(ctx: MarkerContext, points: readonly (readonly [number, number])[]): void {
  points.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

/** Traces the outline of `key`'s shape centred at `c` with half-size `r`. */
function traceShape(ctx: MarkerContext, key: RiskKey, c: number, r: number): void {
  ctx.beginPath();
  switch (key) {
    case "low":
    case "unknown":
      ctx.arc(c, c, r, 0, Math.PI * 2);
      break;
    case "moderate":
      polygon(ctx, [
        [c, c - r],
        [c + r, c],
        [c, c + r],
        [c - r, c],
      ]);
      break;
    case "high":
      // Apex up, base low enough that the triangle's area reads like the other shapes.
      polygon(ctx, [
        [c, c - r],
        [c + r, c + r * 0.8],
        [c - r, c + r * 0.8],
      ]);
      break;
    case "severe":
      polygon(ctx, [
        [c - r * 0.82, c - r * 0.82],
        [c + r * 0.82, c - r * 0.82],
        [c + r * 0.82, c + r * 0.82],
        [c - r * 0.82, c + r * 0.82],
      ]);
      break;
    case "no_travel":
      polygon(
        ctx,
        Array.from({ length: 8 }, (_unused, side): [number, number] => {
          const angle = Math.PI / 8 + (side * Math.PI) / 4;
          return [c + r * Math.cos(angle), c + r * Math.sin(angle)];
        }),
      );
      break;
  }
}

/**
 * Draws `key`'s marker for `theme` into `ctx` at `pixelRatio` (the context's canvas must be
 * {@link markerCanvasSize} times `pixelRatio` on each side).
 */
export function drawMarker(
  ctx: MarkerContext,
  key: RiskKey,
  theme: ResolvedTheme,
  pixelRatio: number,
): void {
  const c = markerCanvasSize(key) / 2;
  const r = MARKER_SIZE[key] / 2;
  ctx.scale(pixelRatio, pixelRatio);
  ctx.lineJoin = "round";
  // The ink hairline first: a stroke twice the hairline wider than the level's stroke, whose inner
  // part the fill and the stroke then cover, leaving 1 px of ink outside (DESIGN.md section 9.5).
  traceShape(ctx, key, c, r);
  ctx.strokeStyle = palette(theme)["map-route-outline-selected"];
  ctx.lineWidth = STROKE_WIDTH + HAIRLINE_WIDTH * 2;
  ctx.stroke();
  ctx.fillStyle = riskFill(theme, key);
  ctx.fill();
  if (key === "unknown") ctx.setLineDash([2, 1.6]);
  ctx.strokeStyle = riskStroke(theme, key);
  ctx.lineWidth = STROKE_WIDTH;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = riskOnFill(theme, key);
  if (key === "no_travel") {
    ctx.fillRect(c - r * 0.55, c - 1.5, r * 1.1, 3);
  } else if (key === "unknown") {
    ctx.font = `bold ${String(r * 1.3)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", c, c + 0.5);
  }
}
