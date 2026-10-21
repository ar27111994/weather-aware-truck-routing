/**
 * The imperative half of the map (DESIGN.md section 9): it owns every MapLibre source, layer, image
 * and marker, re-creates them after each style load (a theme switch replaces the style), and turns
 * store changes into the cheapest MapLibre call that shows them. A slider frame is one
 * `requestAnimationFrame` that writes `feature-state` for the cells that changed and moves the truck
 * markers: no React render, no `setData`, no network.
 */
import { Marker } from "maplibre-gl";
import type {
  ExpressionSpecification,
  LayerSpecification,
  Map as MapLibreMap,
  MapLayerMouseEvent,
  PaddingOptions,
  StyleSpecification,
} from "maplibre-gl";

import type { Heatmap, LonLat, Plan } from "../../api/contract";
import type { RiskKey } from "../../design-system/foundation/risk";
import type { ResolvedTheme } from "../../design-system/foundation/theme";
import { at } from "../../lib/checked";
import { positionAtDistance } from "../../lib/geo";
import type { CheckpointRef, HeatmapLayer } from "../../state/trip-store";
import { basemapOverrides, firstSymbolLayerId, heatmapBeforeId } from "./basemap";
import {
  buildCheckpointCollection,
  buildRibbonCollection,
  buildRouteCollection,
  checkpointFeatureId,
  routeBounds,
} from "./features";
import type { CheckpointProperties, RouteProperties } from "./features";
import { buildCellCollection, decodeHeatmap, frameChanges, heatmapPaint } from "./heatmap";
import type { HeatmapFrames } from "./heatmap";
import { MARKER_SIZE, markerImageId } from "./icons";
import {
  CHECKPOINT_ICON,
  CHECKPOINT_SORT_KEY,
  MAP_RISK_KEYS,
  UNSELECTED_MARKER_OPACITY,
  UNSELECTED_MARKER_SCALE,
  activeMarkerScale,
  hoverExtra,
  labelMinZoom,
  palette,
  ribbonColor,
  riskFill,
  routeWidths,
  unknownDash,
  unselectedOpacity,
  zoomWidth,
} from "./symbology";
import { truckPositions } from "./truck";

/** Source ids (DESIGN.md section 9.2). */
export const SOURCES = {
  routes: "hc-routes",
  ribbon: "hc-ribbon",
  checkpoints: "hc-checkpoints",
  heatmap: "hc-heatmap",
} as const;

/** Layer ids, in the order they stack (bottom to top) within their group. */
export const LAYERS = {
  heatmap: "hc-heatmap",
  casing: "hc-route-casing",
  ribbon: "hc-ribbon",
  ribbonUnknown: "hc-ribbon-unknown",
  outline: "hc-route-outline",
  casingSelected: "hc-route-casing-selected",
  ribbonSelected: "hc-ribbon-selected",
  ribbonUnknownSelected: "hc-ribbon-unknown-selected",
  checkpointHalo: "hc-checkpoint-halo",
  checkpoints: "hc-checkpoints",
  checkpointsSelected: "hc-checkpoints-selected",
} as const;

/** The route and checkpoint layers, bottom to top (the heatmap is separate). */
export const PLAN_LAYERS = [
  LAYERS.casing,
  LAYERS.ribbon,
  LAYERS.ribbonUnknown,
  LAYERS.outline,
  LAYERS.casingSelected,
  LAYERS.ribbonSelected,
  LAYERS.ribbonUnknownSelected,
  LAYERS.checkpointHalo,
  LAYERS.checkpoints,
  LAYERS.checkpointsSelected,
] as const;

/** Layers a pointer can pick a route on. */
const ROUTE_HIT_LAYERS = [LAYERS.casing, LAYERS.casingSelected] as const;
/** Layers a pointer can pick a checkpoint on. */
const CHECKPOINT_HIT_LAYERS = [LAYERS.checkpoints, LAYERS.checkpointsSelected] as const;

/** Duration of a camera move (`--motion-duration-camera`); 0 under reduced motion. */
export const CAMERA_DURATION_MS = 600;
/** Where along its length each route's plate sits, by rank, so near-parallel plates do not stack. */
const PLATE_SHARE = [0.5, 0.4, 0.6] as const;
/** Gap between a checkpoint marker and its highlight ring, in px. */
const HALO_GAP = 3;

/** An image MapLibre accepts in `addImage`. */
export interface MarkerImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

/** DOM elements the markers show; the React side renders their content. */
export interface PlanMarkerElements {
  readonly origin: HTMLElement;
  readonly destination: HTMLElement;
  /** One plate and one truck element per route, in the plan's route order. */
  readonly routes: readonly { readonly plate: HTMLElement; readonly truck: HTMLElement }[];
}

/** Dependencies of a controller; time and drawing are injected so tests can drive them. */
export interface MapControllerOptions {
  /** The basemap style of a theme: OpenFreeMap by default, a blank style in visual goldens. */
  readonly styleFor: (theme: ResolvedTheme) => StyleSpecification | string;
  readonly theme: ResolvedTheme;
  /** Whether camera moves must be instant (`prefers-reduced-motion`), read at each move. */
  readonly isReducedMotion: () => boolean;
  /** Device pixel ratio the marker images are drawn at. */
  readonly pixelRatio: number;
  /** Local ETA text of a checkpoint label. */
  readonly etaLabel: Parameters<typeof buildCheckpointCollection>[1];
  readonly renderIcon: (key: RiskKey, theme: ResolvedTheme, pixelRatio: number) => MarkerImage;
  readonly requestFrame: (callback: () => void) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly onSelectRoute: (routeId: string) => void;
  readonly onHoverCheckpoint: (checkpoint: CheckpointRef | null) => void;
  readonly onOpenCheckpoint: (checkpoint: CheckpointRef) => void;
  /** After each style load, once our layers are back on the map. */
  readonly onStyleReady: () => void;
}

interface PlanState {
  readonly plan: Plan;
  readonly routes: ReturnType<typeof buildRouteCollection>;
  readonly ribbon: ReturnType<typeof buildRibbonCollection>;
  readonly checkpoints: ReturnType<typeof buildCheckpointCollection>;
}

interface HeatmapState {
  readonly frames: HeatmapFrames;
  readonly cellIds: readonly number[];
  readonly cells: ReturnType<typeof buildCellCollection>;
}

interface RouteMarkers {
  readonly routeId: string;
  readonly plate: Marker;
  readonly truck: Marker;
}

function isSelected(selected: string): ExpressionSpecification {
  return ["==", ["get", "route_id"], selected];
}

function isOther(selected: string): ExpressionSpecification {
  return ["!=", ["get", "route_id"], selected];
}

function withLevel(filter: ExpressionSpecification, unknown: boolean): ExpressionSpecification {
  return ["all", filter, [unknown ? "==" : "!=", ["get", "level"], "unknown"]];
}

/** Radius of the highlight ring around each level's marker. */
function haloRadius(): ExpressionSpecification {
  const radius = (key: RiskKey): number => (MARKER_SIZE[key] / 2) * activeMarkerScale() + HALO_GAP;
  return [
    "match",
    ["get", "level"],
    "low",
    radius("low"),
    "moderate",
    radius("moderate"),
    "high",
    radius("high"),
    "severe",
    radius("severe"),
    "no_travel",
    radius("no_travel"),
    radius("unknown"),
  ];
}

/** The checkpoint a layer event is on, read from the feature's properties. */
function eventCheckpoint(event: MapLayerMouseEvent): CheckpointRef | null {
  const properties = event.features?.[0]?.properties as Partial<CheckpointProperties> | undefined;
  const routeId = properties?.route_id;
  const index = properties?.index;
  return typeof routeId === "string" && typeof index === "number" ? { routeId, index } : null;
}

/** `ms` floored to the start of its UTC hour (the heatmap's `start_time` rule, D-09). */
export function floorToHour(ms: number): number {
  return Math.floor(ms / 3_600_000) * 3_600_000;
}

/** Owns the map's Haulcast content; see the module comment. */
export class MapController {
  private readonly map: MapLibreMap;
  private readonly options: MapControllerOptions;
  private theme: ResolvedTheme;
  private styleReady = false;
  private planState: PlanState | undefined;
  private heatmapState: HeatmapState | undefined;
  private origin: Marker | undefined;
  private destination: Marker | undefined;
  private routeMarkers: RouteMarkers[] = [];
  private selectedRouteId: string | null = null;
  private activeIds = new Set<number>();
  private hovered: CheckpointRef | null = null;
  private open: CheckpointRef | null = null;
  private hoveredRoute: number | undefined;
  private field: HeatmapLayer = "risk";
  private heatmapVisible = true;
  private frame = 0;
  private written: Int8Array | Float64Array | undefined;
  private pendingFrame: number | undefined;
  private readonly unsubscribers: (() => void)[] = [];

  constructor(map: MapLibreMap, options: MapControllerOptions) {
    this.map = map;
    this.options = options;
    this.theme = options.theme;
    this.map.on("style.load", this.handleStyleLoad);
    this.unsubscribers.push(() => this.map.off("style.load", this.handleStyleLoad));
    for (const layer of ROUTE_HIT_LAYERS) this.listenLayer("click", layer, this.handleRouteClick);
    this.listenLayer("mousemove", LAYERS.casing, this.handleRouteHover);
    this.listenLayer("mouseleave", LAYERS.casing, this.handleRouteLeave);
    for (const layer of CHECKPOINT_HIT_LAYERS) {
      this.listenLayer("click", layer, this.handleCheckpointClick);
      this.listenLayer("mousemove", layer, this.handleCheckpointHover);
      this.listenLayer("mouseleave", layer, this.handleCheckpointLeave);
    }
  }

  // Event wiring --------------------------------------------------------------------------------

  private listenLayer(
    type: "click" | "mousemove" | "mouseleave",
    layer: string,
    handler: (event: MapLayerMouseEvent) => void,
  ): void {
    this.map.on(type, layer, handler);
    this.unsubscribers.push(() => this.map.off(type, layer, handler));
  }

  private readonly handleRouteClick = (event: MapLayerMouseEvent): void => {
    const properties = event.features?.[0]?.properties as Partial<RouteProperties> | undefined;
    const routeId = properties?.route_id;
    if (typeof routeId === "string") this.options.onSelectRoute(routeId);
  };

  private readonly handleRouteHover = (event: MapLayerMouseEvent): void => {
    const id = event.features?.[0]?.id;
    const position = typeof id === "number" ? id : undefined;
    this.map.getCanvas().style.cursor = "pointer";
    if (position === this.hoveredRoute) return;
    this.setRouteHover(false);
    this.hoveredRoute = position;
    this.setRouteHover(true);
  };

  private readonly handleRouteLeave = (): void => {
    this.setRouteHover(false);
    this.hoveredRoute = undefined;
    this.map.getCanvas().style.cursor = "";
  };

  private setRouteHover(hover: boolean): void {
    if (this.hoveredRoute === undefined || !this.styleReady) return;
    this.map.setFeatureState({ source: SOURCES.routes, id: this.hoveredRoute }, { hover });
  }

  private readonly handleCheckpointClick = (event: MapLayerMouseEvent): void => {
    const checkpoint = eventCheckpoint(event);
    if (checkpoint) this.options.onOpenCheckpoint(checkpoint);
  };

  private readonly handleCheckpointHover = (event: MapLayerMouseEvent): void => {
    this.map.getCanvas().style.cursor = "pointer";
    this.options.onHoverCheckpoint(eventCheckpoint(event));
  };

  private readonly handleCheckpointLeave = (): void => {
    this.map.getCanvas().style.cursor = "";
    this.options.onHoverCheckpoint(null);
  };

  // Style loading -------------------------------------------------------------------------------

  /** Everything a new style lacks: images, overrides, sources, layers and their state. */
  private readonly handleStyleLoad = (): void => {
    this.styleReady = true;
    for (const key of MAP_RISK_KEYS) {
      this.map.addImage(
        markerImageId(key),
        this.options.renderIcon(key, this.theme, this.options.pixelRatio),
        { pixelRatio: this.options.pixelRatio },
      );
    }
    for (const override of basemapOverrides(this.theme, this.map.getStyle().layers)) {
      this.map.setPaintProperty(override.layer, override.property, override.value);
    }
    this.addHeatmapLayer();
    this.addPlanLayers();
    this.hoveredRoute = undefined;
    this.activeIds = new Set();
    this.applySelection();
    this.applyActive();
    this.written = undefined;
    this.applyFrame();
    this.options.onStyleReady();
  };

  private addPlanLayers(): void {
    const state = this.planState;
    if (!state || !this.styleReady) return;
    this.map.addSource(SOURCES.routes, { type: "geojson", data: state.routes });
    this.map.addSource(SOURCES.ribbon, { type: "geojson", data: state.ribbon });
    this.map.addSource(SOURCES.checkpoints, { type: "geojson", data: state.checkpoints });
    const before = firstSymbolLayerId(this.map.getStyle().layers);
    for (const layer of this.routeLayers()) this.map.addLayer(layer, before);
    for (const layer of this.checkpointLayers()) this.map.addLayer(layer);
  }

  /** Route casings, outline and risk ribbons (DESIGN.md sections 9.3 and 9.4). */
  private routeLayers(): LayerSpecification[] {
    const p = palette(this.theme);
    const other = routeWidths(false);
    const selected = routeWidths(true);
    const round = { "line-join": "round", "line-cap": "round" } as const;
    // Butt caps keep the colour boundaries between ribbon stretches crisp.
    const butt = { "line-join": "round", "line-cap": "butt" } as const;
    const unknown = riskFill(this.theme, "unknown");
    return [
      {
        id: LAYERS.casing,
        type: "line",
        source: SOURCES.routes,
        layout: round,
        paint: {
          "line-color": p["map-route-casing"],
          "line-width": zoomWidth(other.casing, hoverExtra()),
          "line-opacity": unselectedOpacity(),
        },
      },
      {
        id: LAYERS.ribbon,
        type: "line",
        source: SOURCES.ribbon,
        layout: butt,
        paint: {
          "line-color": ribbonColor(this.theme),
          "line-width": zoomWidth(other.ribbon),
          "line-opacity": unselectedOpacity(),
        },
      },
      {
        id: LAYERS.ribbonUnknown,
        type: "line",
        source: SOURCES.ribbon,
        layout: butt,
        paint: {
          "line-color": unknown,
          "line-width": zoomWidth(other.ribbon),
          "line-opacity": unselectedOpacity(),
          "line-dasharray": unknownDash(),
        },
      },
      {
        id: LAYERS.outline,
        type: "line",
        source: SOURCES.routes,
        layout: round,
        paint: {
          "line-color": p["map-route-outline-selected"],
          "line-width": zoomWidth(selected.outline),
        },
      },
      {
        id: LAYERS.casingSelected,
        type: "line",
        source: SOURCES.routes,
        layout: round,
        paint: { "line-color": p["map-route-casing"], "line-width": zoomWidth(selected.casing) },
      },
      {
        id: LAYERS.ribbonSelected,
        type: "line",
        source: SOURCES.ribbon,
        layout: butt,
        paint: { "line-color": ribbonColor(this.theme), "line-width": zoomWidth(selected.ribbon) },
      },
      {
        id: LAYERS.ribbonUnknownSelected,
        type: "line",
        source: SOURCES.ribbon,
        layout: butt,
        paint: {
          "line-color": unknown,
          "line-width": zoomWidth(selected.ribbon),
          "line-dasharray": unknownDash(),
        },
      },
    ];
  }

  /** Checkpoint markers on every route (D-14) and the highlight ring (DESIGN.md section 9.5). */
  private checkpointLayers(): LayerSpecification[] {
    const p = palette(this.theme);
    const icon = {
      "icon-image": CHECKPOINT_ICON,
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "symbol-sort-key": CHECKPOINT_SORT_KEY,
    } as const;
    return [
      {
        // Feature-state drives paint only (`icon-size` is layout), so the highlight of a hovered
        // or open checkpoint is a ring around its marker rather than a bigger icon.
        id: LAYERS.checkpointHalo,
        type: "circle",
        source: SOURCES.checkpoints,
        paint: {
          "circle-radius": haloRadius(),
          "circle-opacity": 0,
          "circle-stroke-width": 2,
          "circle-stroke-color": p["map-route-outline-selected"],
          "circle-stroke-opacity": ["case", ["boolean", ["feature-state", "active"], false], 1, 0],
        },
      },
      {
        id: LAYERS.checkpoints,
        type: "symbol",
        source: SOURCES.checkpoints,
        layout: { ...icon, "icon-size": UNSELECTED_MARKER_SCALE },
        paint: { "icon-opacity": UNSELECTED_MARKER_OPACITY },
      },
      {
        id: LAYERS.checkpointsSelected,
        type: "symbol",
        source: SOURCES.checkpoints,
        layout: {
          ...icon,
          "text-field": ["step", ["zoom"], "", labelMinZoom(), ["get", "eta"]],
          "text-font": [...p["font-family-map"]],
          "text-size": 12,
          "text-offset": [0, 1.4],
          "text-optional": true,
        },
        paint: {
          "text-color": p["map-label-text"],
          "text-halo-color": p["map-label-halo"],
          "text-halo-width": 2,
        },
      },
    ];
  }

  private addHeatmapLayer(): void {
    const state = this.heatmapState;
    if (!state || !this.styleReady) return;
    this.map.addSource(SOURCES.heatmap, { type: "geojson", data: state.cells });
    this.map.addLayer(
      {
        id: LAYERS.heatmap,
        type: "fill",
        source: SOURCES.heatmap,
        layout: { visibility: this.heatmapVisible ? "visible" : "none" },
        paint: { ...heatmapPaint(this.field, this.theme), "fill-antialias": true },
      },
      heatmapBeforeId(this.map.getStyle().layers),
    );
  }

  // Public API ----------------------------------------------------------------------------------

  /** Shows a plan: builds its GeoJSON once and places the pins, plates and trucks. */
  setPlan(plan: Plan, elements: PlanMarkerElements): void {
    this.removePlanLayers();
    this.removeMarkers();
    this.planState = {
      plan,
      routes: buildRouteCollection(plan),
      ribbon: buildRibbonCollection(plan),
      checkpoints: buildCheckpointCollection(plan, this.options.etaLabel),
    };
    this.addMarkers(plan, elements);
    this.addPlanLayers();
    this.applySelection();
    this.applyActive();
    this.applyTrucks();
  }

  /** Shows a heatmap (its 49 frames decoded once), or removes it with `undefined`. */
  setHeatmap(heatmap: Heatmap | undefined): void {
    this.removeHeatmapLayer();
    this.heatmapState =
      heatmap === undefined
        ? undefined
        : {
            frames: decodeHeatmap(heatmap),
            cellIds: heatmap.cells,
            cells: buildCellCollection(heatmap.grid, heatmap.cells),
          };
    this.written = undefined;
    this.addHeatmapLayer();
    this.applyFrame();
  }

  /** Switches the basemap; our layers come back in the `style.load` handler. */
  setTheme(theme: ResolvedTheme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    this.styleReady = false;
    this.map.setStyle(this.options.styleFor(theme), { diff: false });
  }

  /** Draws `routeId` on top with full emphasis, the others muted (null: all muted). */
  setSelectedRoute(routeId: string | null): void {
    if (routeId === this.selectedRouteId) return;
    this.selectedRouteId = routeId;
    this.applySelection();
  }

  /** Highlights the hovered checkpoint. */
  setHoveredCheckpoint(checkpoint: CheckpointRef | null): void {
    this.hovered = checkpoint;
    this.applyActive();
  }

  /** Highlights the checkpoint whose details are open. */
  setOpenCheckpoint(checkpoint: CheckpointRef | null): void {
    this.open = checkpoint;
    this.applyActive();
  }

  /** Shows heatmap frame `frame` and moves the trucks, at most once per animation frame. */
  setFrame(frame: number): void {
    this.frame = frame;
    if (this.pendingFrame !== undefined) return;
    this.pendingFrame = this.options.requestFrame(() => {
      this.pendingFrame = undefined;
      this.applyFrame();
    });
  }

  /** Switches the heatmap layer (risk, wind, rain, snow): a paint change, not a data change. */
  setField(field: HeatmapLayer): void {
    if (field === this.field) return;
    this.field = field;
    this.written = undefined;
    if (this.styleReady && this.heatmapState) {
      const paint = heatmapPaint(field, this.theme);
      this.map.setPaintProperty(LAYERS.heatmap, "fill-color", paint["fill-color"]);
      this.map.setPaintProperty(LAYERS.heatmap, "fill-opacity", paint["fill-opacity"]);
    }
    this.applyHeatmapFrame();
  }

  /** Shows or hides the heatmap layer. */
  setHeatmapVisible(visible: boolean): void {
    if (visible === this.heatmapVisible) return;
    this.heatmapVisible = visible;
    if (this.styleReady && this.heatmapState) {
      this.map.setLayoutProperty(LAYERS.heatmap, "visibility", visible ? "visible" : "none");
    }
  }

  /** Frames every route, clear of the panels the caller names in `padding`. */
  fitRoutes(padding: PaddingOptions): void {
    const state = this.planState;
    if (!state) return;
    this.map.fitBounds(routeBounds(state.plan), {
      padding,
      duration: this.options.isReducedMotion() ? 0 : CAMERA_DURATION_MS,
      maxZoom: 10,
    });
  }

  /** Moves the camera to a checkpoint (from the table or the chart), keeping the zoom. */
  focusCheckpoint(checkpoint: CheckpointRef): void {
    const position = this.checkpointPosition(checkpoint);
    if (!position) return;
    if (this.options.isReducedMotion()) this.map.jumpTo({ center: position });
    else this.map.easeTo({ center: position, duration: CAMERA_DURATION_MS });
  }

  /** A checkpoint's position, or `undefined` when the plan has no such checkpoint. */
  checkpointPosition(checkpoint: CheckpointRef): LonLat | undefined {
    const found = this.planState?.plan.routes
      .find((route) => route.route_id === checkpoint.routeId)
      ?.checkpoints.find((candidate) => candidate.index === checkpoint.index);
    return found ? [found.lon, found.lat] : undefined;
  }

  /** Stops every listener, frame and marker; the caller then removes the map. */
  destroy(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    if (this.pendingFrame !== undefined) this.options.cancelFrame(this.pendingFrame);
    this.pendingFrame = undefined;
    this.removeMarkers();
  }

  // Applying state ------------------------------------------------------------------------------

  private applySelection(): void {
    if (this.planState && this.styleReady) {
      const selected = this.selectedRouteId ?? "";
      this.map.setFilter(LAYERS.casing, isOther(selected));
      this.map.setFilter(LAYERS.ribbon, withLevel(isOther(selected), false));
      this.map.setFilter(LAYERS.ribbonUnknown, withLevel(isOther(selected), true));
      this.map.setFilter(LAYERS.outline, isSelected(selected));
      this.map.setFilter(LAYERS.casingSelected, isSelected(selected));
      this.map.setFilter(LAYERS.ribbonSelected, withLevel(isSelected(selected), false));
      this.map.setFilter(LAYERS.ribbonUnknownSelected, withLevel(isSelected(selected), true));
      this.map.setFilter(LAYERS.checkpoints, isOther(selected));
      this.map.setFilter(LAYERS.checkpointsSelected, isSelected(selected));
    }
    for (const markers of this.routeMarkers) {
      const selected = markers.routeId === this.selectedRouteId;
      for (const marker of [markers.plate, markers.truck]) {
        marker.getElement().dataset["selected"] = String(selected);
      }
      // The selected route's plate and truck draw above the others'.
      markers.plate.getElement().style.zIndex = selected ? "2" : "1";
      markers.truck.getElement().style.zIndex = selected ? "4" : "3";
    }
  }

  private applyActive(): void {
    if (!this.styleReady || !this.planState) return;
    const routes = this.planState.plan.routes;
    const next = new Set<number>();
    for (const checkpoint of [this.hovered, this.open]) {
      const position = routes.findIndex((route) => route.route_id === checkpoint?.routeId);
      if (checkpoint && position !== -1) next.add(checkpointFeatureId(position, checkpoint.index));
    }
    for (const id of this.activeIds) {
      if (!next.has(id)) {
        this.map.setFeatureState({ source: SOURCES.checkpoints, id }, { active: false });
      }
    }
    for (const id of next) {
      if (!this.activeIds.has(id)) {
        this.map.setFeatureState({ source: SOURCES.checkpoints, id }, { active: true });
      }
    }
    this.activeIds = next;
  }

  private applyFrame(): void {
    this.applyHeatmapFrame();
    this.applyTrucks();
  }

  private applyHeatmapFrame(): void {
    const state = this.heatmapState;
    if (!state || !this.styleReady) return;
    const values = state.frames.frame(this.field, this.frame);
    for (const position of frameChanges(this.written, values)) {
      this.map.setFeatureState(
        { source: SOURCES.heatmap, id: at(state.cellIds, position) },
        { v: values[position] },
      );
    }
    this.written = values;
  }

  private applyTrucks(): void {
    const state = this.planState;
    if (!state) return;
    const start =
      this.heatmapState?.frames.startTime ??
      floorToHour(Date.parse(state.plan.request.departure_time));
    truckPositions(state.plan, start, this.frame).forEach((truck, position) => {
      const marker = at(this.routeMarkers, position).truck;
      marker.getElement().hidden = truck.position === null;
      if (truck.position) marker.setLngLat(truck.position);
    });
  }

  // Markers and teardown ------------------------------------------------------------------------

  private addMarkers(plan: Plan, elements: PlanMarkerElements): void {
    const coords = at(plan.routes, 0).geometry.coordinates;
    this.origin = new Marker({ element: elements.origin }).setLngLat(at(coords, 0)).addTo(this.map);
    this.destination = new Marker({ element: elements.destination })
      .setLngLat(at(coords, coords.length - 1))
      .addTo(this.map);
    this.routeMarkers = plan.routes.map((route, position) => {
      const plateAt = positionAtDistance(
        route.geometry.coordinates,
        route.cumulative_mi,
        route.distance_mi * at(PLATE_SHARE, position),
      );
      const { plate, truck } = at(elements.routes, position);
      truck.hidden = true;
      return {
        routeId: route.route_id,
        plate: new Marker({ element: plate }).setLngLat(plateAt).addTo(this.map),
        truck: new Marker({ element: truck }).setLngLat(plateAt).addTo(this.map),
      };
    });
  }

  private removeMarkers(): void {
    this.origin?.remove();
    this.destination?.remove();
    this.origin = undefined;
    this.destination = undefined;
    for (const markers of this.routeMarkers) {
      markers.plate.remove();
      markers.truck.remove();
    }
    this.routeMarkers = [];
  }

  private removePlanLayers(): void {
    if (!this.planState || !this.styleReady) return;
    for (const id of PLAN_LAYERS) this.map.removeLayer(id);
    this.map.removeSource(SOURCES.routes);
    this.map.removeSource(SOURCES.ribbon);
    this.map.removeSource(SOURCES.checkpoints);
    this.activeIds = new Set();
    this.hoveredRoute = undefined;
  }

  private removeHeatmapLayer(): void {
    if (!this.heatmapState || !this.styleReady) return;
    this.map.removeLayer(LAYERS.heatmap);
    this.map.removeSource(SOURCES.heatmap);
  }
}
