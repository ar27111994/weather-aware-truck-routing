/** Draws a checkpoint marker on a canvas and returns its pixels for `map.addImage`. */
import type { RiskKey } from "../../design-system/foundation/risk";
import type { ResolvedTheme } from "../../design-system/foundation/theme";
import { drawMarker, markerCanvasSize } from "./icons";
import type { MarkerImage } from "./map-controller";

/**
 * The marker image of `key` in `theme` at `pixelRatio`.
 *
 * @throws {Error} when the browser gives no 2D canvas context (every supported browser does).
 */
export function renderMarkerImage(
  key: RiskKey,
  theme: ResolvedTheme,
  pixelRatio: number,
): MarkerImage {
  const size = Math.ceil(markerCanvasSize(key) * pixelRatio);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot draw the map markers (no 2D canvas)");
  drawMarker(context, key, theme, pixelRatio);
  return context.getImageData(0, 0, size, size);
}
