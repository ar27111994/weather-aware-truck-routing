import "maplibre-gl/dist/maplibre-gl.css";

import { Flag, Maximize2, Truck } from "lucide-react";
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl";
import type { MapLibreEvent, PaddingOptions, StyleSpecification } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";

import type { Heatmap, Plan } from "../../api/contract";
import { Icon } from "../../design-system/components/Icon";
import { IconButton } from "../../design-system/components/IconButton";
import { Popover } from "../../design-system/components/Popover";
import { VisuallyHidden } from "../../design-system/components/VisuallyHidden";
import { cx } from "../../design-system/foundation/cx";
import { t, tPlural } from "../../design-system/foundation/strings";
import type { ResolvedTheme } from "../../design-system/foundation/theme";
import { useMediaQuery } from "../../design-system/foundation/useMediaQuery";
import { at } from "../../lib/checked";
import {
  tripStore,
  useOpenCheckpoint,
  useSelectedRouteId,
  useTripActions,
} from "../../state/trip-store";
import type { CheckpointRef, TripState, TripStore } from "../../state/trip-store";
import { basemapStyleUrl } from "./basemap";
import { CheckpointDetails } from "./CheckpointDetails";
import { checkpointDetails } from "./checkpoint-details";
import { createEtaLabel } from "./eta";
import { MapController } from "./map-controller";
import type { PlanMarkerElements } from "./map-controller";
import styles from "./MapView.module.css";
import { renderMarkerImage } from "./marker-image";

// MapLibre 6 starts its worker from a sibling of its own module URL, which bundling breaks, so the
// worker ships as a same-origin asset and the policy needs `worker-src 'self'` only, no `blob:`
// (the MapLibre CSP guide's self-hosted case; D-25).
setWorkerUrl(workerUrl);

/** Camera moves become jumps under this query (DESIGN.md section 6). */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Room kept clear around the routes by default: the timeline dock and legend sit at the bottom. */
export const DEFAULT_PADDING: PaddingOptions = { top: 72, right: 72, bottom: 136, left: 72 };

export interface MapViewProps {
  readonly plan: Plan;
  /** The corridor forecast; the heatmap layer appears when it arrives. */
  readonly heatmap?: Heatmap | undefined;
  readonly theme: ResolvedTheme;
  /** Space the surrounding layout covers over the map (panel, sheet, dock), for "fit routes". */
  readonly padding?: PaddingOptions;
  readonly store?: TripStore;
  /** BCP 47 locale for times and numbers (D-16); the user's own by default. */
  readonly locale?: string;
  /** The basemap of a theme; OpenFreeMap Positron and Dark by default (DESIGN.md section 9.1). */
  readonly basemap?: (theme: ResolvedTheme) => StyleSpecification | string;
  /** Overlays drawn over the map, such as the legend and the timeline dock. */
  readonly children?: ReactNode;
  readonly className?: string;
}

/** The live map: created when the container mounts, gone when it unmounts. */
interface LiveMap {
  readonly map: MapLibreMap;
  readonly controller: MapController;
}

/** Where the popover is anchored: a checkpoint and its point on screen once the camera settled. */
interface Anchor {
  readonly checkpoint: CheckpointRef;
  readonly x: number;
  readonly y: number;
}

function sameCheckpoint(a: CheckpointRef | null, b: CheckpointRef | null): boolean {
  return a?.routeId === b?.routeId && a?.index === b?.index;
}

/** The first part of a place label ("Salt Lake City" of "Salt Lake City, Utah, United States"). */
function placeName(label: string): string {
  return label.replace(/,.*$/s, "");
}

function createMarkerElements(plan: Plan): PlanMarkerElements {
  const slot = (): HTMLElement => {
    const element = document.createElement("div");
    element.className = styles.slot;
    return element;
  };
  return {
    origin: slot(),
    destination: slot(),
    routes: plan.routes.map(() => ({ plate: slot(), truck: slot() })),
  };
}

/** Pushes every store change the map shows to the controller; no React render in between. */
function syncStore(store: TripStore, controller: MapController): () => void {
  let previous: TripState | undefined;
  const sync = (): void => {
    const state = store.getState();
    if (state.selectedRouteId !== previous?.selectedRouteId) {
      controller.setSelectedRoute(state.selectedRouteId);
    }
    if (state.hoveredCheckpoint !== previous?.hoveredCheckpoint) {
      controller.setHoveredCheckpoint(state.hoveredCheckpoint);
    }
    if (state.openCheckpoint !== previous?.openCheckpoint) {
      controller.setOpenCheckpoint(state.openCheckpoint);
    }
    if (state.heatmapField !== previous?.heatmapField) controller.setField(state.heatmapField);
    if (state.heatmapVisible !== previous?.heatmapVisible) {
      controller.setHeatmapVisible(state.heatmapVisible);
    }
    if (state.sliderFrame !== previous?.sliderFrame) controller.setFrame(state.sliderFrame);
    previous = state;
  };
  sync();
  return store.subscribe(sync);
}

/**
 * The route map (R6, R7, R16): basemap per theme, every route with its risk ribbon, checkpoint
 * markers, pins, plates, truck markers at the slider's time, the corridor heatmap and the
 * checkpoint popover. MapLibre lives only in this module's chunk; import it lazily (`./index.ts`).
 */
export default function MapView({
  plan,
  heatmap,
  theme,
  padding = DEFAULT_PADDING,
  basemap = basemapStyleUrl,
  store = tripStore,
  locale,
  children,
  className,
}: MapViewProps): ReactElement {
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const actions = useTripActions(store);
  const selectedRouteId = useSelectedRouteId(store);
  const open = useOpenCheckpoint(store);
  const [live, setLive] = useState<LiveMap | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const summaryId = useId();
  const elements = useMemo(() => createMarkerElements(plan), [plan]);
  const etaLabel = useMemo(() => createEtaLabel(locale), [locale]);
  // What the map reads at the moment it needs it (a camera move, a label, a style load).
  const latest = useRef({ theme, padding, reducedMotion, etaLabel, basemap });
  useEffect(() => {
    latest.current = { theme, padding, reducedMotion, etaLabel, basemap };
  });

  // A callback ref with a cleanup (React 19): the map exists exactly while its container does.
  const mountMap = useCallback(
    (container: HTMLDivElement) => {
      const map = new MapLibreMap({
        container,
        style: latest.current.basemap(latest.current.theme),
        attributionControl: false,
        // A planning view of the whole corridor: it never rotates or tilts.
        dragRotate: false,
        pitchWithRotate: false,
        locale: {
          "Map.Title": t("app.regions.map"),
          "NavigationControl.ZoomIn": t("map.zoomIn"),
          "NavigationControl.ZoomOut": t("map.zoomOut"),
        },
      });
      map.addControl(new NavigationControl({ showCompass: false }), "top-right");
      map.addControl(
        new AttributionControl({
          compact: true,
          customAttribution: [t("footer.osm"), t("footer.openmeteo")],
        }),
        "bottom-right",
      );
      map.getCanvas().setAttribute("aria-describedby", summaryId);
      const controller = new MapController(map, {
        theme: latest.current.theme,
        styleFor: (theme) => latest.current.basemap(theme),
        isReducedMotion: () => latest.current.reducedMotion,
        pixelRatio: window.devicePixelRatio,
        etaLabel: (checkpoint) => latest.current.etaLabel(checkpoint),
        renderIcon: renderMarkerImage,
        requestFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (handle) => {
          cancelAnimationFrame(handle);
        },
        onSelectRoute: actions.selectRoute,
        onHoverCheckpoint: actions.hoverCheckpoint,
        onOpenCheckpoint: actions.openCheckpoint,
        onStyleReady: () => {
          container.dataset["styleReady"] = "true";
        },
      });
      const unsubscribe = syncStore(store, controller);
      // A camera move the user starts (drag, wheel, keys) closes the popover: it is anchored to a
      // point on screen, which would slide away from it.
      const closeOnUserMove = (
        event: MapLibreEvent & { readonly originalEvent?: unknown },
      ): void => {
        if (event.originalEvent !== undefined) actions.openCheckpoint(null);
      };
      const markIdle = (): void => {
        container.dataset["idle"] = "true";
      };
      const markBusy = (): void => {
        container.dataset["idle"] = "false";
      };
      map.on("movestart", closeOnUserMove);
      map.on("idle", markIdle);
      map.on("dataloading", markBusy);
      const resize = new ResizeObserver(() => {
        map.resize();
      });
      resize.observe(container);
      setLive({ map, controller });
      return () => {
        resize.disconnect();
        unsubscribe();
        map.off("movestart", closeOnUserMove);
        map.off("idle", markIdle);
        map.off("dataloading", markBusy);
        controller.destroy();
        map.remove();
        setLive(null);
      };
    },
    [store, actions, summaryId],
  );

  useEffect(() => {
    live?.controller.setTheme(theme);
  }, [live, theme]);
  useEffect(() => {
    if (!live) return;
    live.controller.setPlan(plan, elements);
    live.controller.fitRoutes(latest.current.padding);
  }, [live, plan, elements]);
  useEffect(() => {
    live?.controller.setHeatmap(heatmap);
  }, [live, heatmap]);

  // Opening a checkpoint brings it into view, then anchors the popover where it settled.
  useEffect(() => {
    if (!live || !open) return undefined;
    const position = live.controller.checkpointPosition(open);
    if (!position) return undefined;
    const settle = (): void => {
      const point = live.map.project(position);
      setAnchor({ checkpoint: open, x: point.x, y: point.y });
    };
    live.map.once("moveend", settle);
    live.controller.focusCheckpoint(open);
    return () => {
      live.map.off("moveend", settle);
    };
  }, [live, open]);

  const details = useMemo(
    () => (open ? checkpointDetails(plan, open, locale) : null),
    [plan, open, locale],
  );
  const popoverOpen = details !== null && sameCheckpoint(open, anchor?.checkpoint ?? null);
  const summary = [
    tPlural("status.planReady", plan.routes.length, { route: plan.recommendation.route_id }),
    ...(selectedRouteId === null ? [] : [t("status.routeSelected", { route: selectedRouteId })]),
  ].join(" ");

  return (
    <div
      className={cx(styles.root, className)}
      data-heatmap={heatmap === undefined ? "loading" : "ready"}
    >
      <div ref={mountMap} className={styles.map} data-testid="map-canvas-container" />
      <div
        ref={anchorRef}
        className={styles.anchor}
        style={{ transform: `translate(${String(anchor?.x ?? 0)}px, ${String(anchor?.y ?? 0)}px)` }}
        tabIndex={-1}
      />
      <IconButton
        icon={Maximize2}
        label={t("map.fit")}
        variant="secondary"
        className={styles.fit}
        onPress={() => {
          live?.controller.fitRoutes(latest.current.padding);
        }}
      />
      {children}
      <VisuallyHidden elementType="div">
        <p id={summaryId}>{summary}</p>
      </VisuallyHidden>
      {createPortal(
        <span
          className={styles.origin}
          role="img"
          aria-label={t("map.origin", { name: placeName(plan.request.origin.label) })}
        />,
        elements.origin,
      )}
      {createPortal(
        <span
          className={styles.destination}
          role="img"
          aria-label={t("map.destination", { name: placeName(plan.request.destination.label) })}
        >
          <Icon icon={Flag} size={16} />
        </span>,
        elements.destination,
      )}
      {plan.routes.map((route, position) => (
        <RouteMarkerContent
          key={route.route_id}
          routeId={route.route_id}
          slots={at(elements.routes, position)}
          selected={route.route_id === selectedRouteId}
          onSelect={actions.selectRoute}
        />
      ))}
      {details ? (
        <Popover
          label={details.title}
          triggerRef={anchorRef}
          isOpen={popoverOpen}
          // Without a trigger of its own, the popover only ever asks to close (Escape, dismiss).
          onOpenChange={() => {
            actions.openCheckpoint(null);
          }}
          isNonModal
          width="checkpoint"
          placement="top"
        >
          <CheckpointDetails
            details={details}
            onClose={() => {
              actions.openCheckpoint(null);
            }}
          />
        </Popover>
      ) : null}
    </div>
  );
}

interface RouteMarkerContentProps {
  readonly routeId: string;
  readonly slots: PlanMarkerElements["routes"][number];
  readonly selected: boolean;
  readonly onSelect: (routeId: string) => void;
}

/** A route's plate (a button that selects it) and its truck, rendered into their marker elements. */
function RouteMarkerContent({
  routeId,
  slots,
  selected,
  onSelect,
}: RouteMarkerContentProps): ReactElement {
  return (
    <>
      {createPortal(
        <button
          type="button"
          className={styles.plate}
          aria-label={t("route.select", { route: routeId })}
          aria-pressed={selected}
          onClick={() => {
            onSelect(routeId);
          }}
        >
          {routeId}
        </button>,
        slots.plate,
      )}
      {createPortal(
        <span className={styles.truck} aria-hidden="true">
          <Icon icon={Truck} size={16} />
          {routeId}
        </span>,
        slots.truck,
      )}
    </>
  );
}
