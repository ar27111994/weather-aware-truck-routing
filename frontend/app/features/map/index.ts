/**
 * The map feature (R6, R7, R16). `MapView` is lazy: importing this module never loads MapLibre,
 * whose chunk downloads when the view first renders (wrap it in `Suspense`). The dock and the
 * legend are light and load with the page; each reads and drives the shared trip store.
 */
import { lazy } from "react";

export { MapLegend } from "./MapLegend";
export type { MapLegendProps } from "./MapLegend";
export { DEFAULT_PADDING } from "./padding";
export { TimelineDock } from "./TimelineDock";
export type { TimelineDockProps } from "./TimelineDock";
export type { MapViewProps } from "./MapView";

/** The route map, loaded on first render together with MapLibre (its own chunk). */
export const MapView = lazy(() => import("./MapView"));
