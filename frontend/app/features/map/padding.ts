/**
 * Camera padding for "fit routes". It lives apart from `MapView` so a page can read it without
 * pulling MapLibre into its own chunk (`MapView` is lazy).
 */
import type { PaddingOptions } from "maplibre-gl";

/** Room kept clear around the routes by default: the timeline dock and legend sit at the bottom. */
export const DEFAULT_PADDING: PaddingOptions = { top: 72, right: 72, bottom: 136, left: 72 };
