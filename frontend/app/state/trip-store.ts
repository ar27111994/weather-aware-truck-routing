import { useMemo, useSyncExternalStore } from "react";

import { HEATMAP_FRAME_COUNT, type Plan } from "../api/contract";

/** The map layer the heatmap shows (risk level, or one raw forecast field). */
export type HeatmapLayer = "risk" | "wind_mph" | "rain_in_hr" | "snow_in_hr";

/** A checkpoint of a route, identified for hover linking between the map, table and chart. */
export interface CheckpointRef {
  readonly routeId: string;
  readonly index: number;
}

/** Everything the map and the results panel share. */
export interface TripState {
  readonly selectedRouteId: string | null;
  readonly hoveredCheckpoint: CheckpointRef | null;
  /**
   * The checkpoint whose details are open: the map anchors its popover there. Selecting a table row
   * or a chart dot opens it; the map flies to it (DESIGN.md section 9.5).
   */
  readonly openCheckpoint: CheckpointRef | null;
  /** Forecast hour shown on the heatmap: an integer in 0..48. */
  readonly sliderFrame: number;
  readonly heatmapField: HeatmapLayer;
  /** Whether the corridor heatmap is drawn ("Show forecast map"). */
  readonly heatmapVisible: boolean;
  readonly playing: boolean;
}

/** State transitions; the methods never use `this`, so they can be passed around freely. */
export interface TripActions {
  selectRoute: (routeId: string | null) => void;
  hoverCheckpoint: (checkpoint: CheckpointRef | null) => void;
  /** Opens a checkpoint's details (and selects its route), or closes them with `null`. */
  openCheckpoint: (checkpoint: CheckpointRef | null) => void;
  /** Rounds to an integer and clamps to 0..48; NaN is ignored. */
  setFrame: (frame: number) => void;
  /** `setFrame(current + delta)`: no wrap-around. */
  stepFrame: (delta: number) => void;
  setField: (field: HeatmapLayer) => void;
  setHeatmapVisible: (visible: boolean) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  /** Selects the recommended route, rewinds to frame 0 and pauses; the field is kept. */
  resetForPlan: (plan: Plan) => void;
}

/** A tiny external store (React's `useSyncExternalStore`). */
export interface TripStore {
  getState: () => TripState;
  /**
   * The state the store was created with: what a server render (the prerendered routes) shows and
   * what the client shows while it hydrates that markup, so hydration matches whatever happens
   * later.
   */
  getInitialState: () => TripState;
  subscribe: (listener: () => void) => () => void;
  readonly actions: TripActions;
}

const MAX_FRAME = HEATMAP_FRAME_COUNT - 1;

const DEFAULT_STATE: TripState = {
  selectedRouteId: null,
  hoveredCheckpoint: null,
  openCheckpoint: null,
  sliderFrame: 0,
  heatmapField: "risk",
  heatmapVisible: true,
  playing: false,
};

function clampFrame(frame: number): number {
  return Math.min(MAX_FRAME, Math.max(0, Math.round(frame)));
}

function sameCheckpoint(a: CheckpointRef | null, b: CheckpointRef | null): boolean {
  return a?.routeId === b?.routeId && a?.index === b?.index;
}

/**
 * Creates a store. State objects are replaced only when something actually changes, so a no-op
 * action never wakes a subscriber (and never re-renders a component).
 */
export function createTripStore(initial: Partial<TripState> = {}): TripStore {
  const initialState: TripState = { ...DEFAULT_STATE, ...initial };
  let state = initialState;
  let listeners: readonly (() => void)[] = [];

  const update = (patch: Partial<TripState>): void => {
    const next = { ...state, ...patch };
    const changed = (Object.keys(patch) as (keyof TripState)[]).some(
      (key) => next[key] !== state[key],
    );
    if (!changed) return;
    state = next;
    for (const listener of listeners) {
      if (listeners.includes(listener)) listener();
    }
  };

  const setFrame = (frame: number): void => {
    if (Number.isNaN(frame)) return;
    update({ sliderFrame: clampFrame(frame) });
  };

  const actions: TripActions = {
    selectRoute: (routeId) => {
      update({ selectedRouteId: routeId });
    },
    hoverCheckpoint: (checkpoint) => {
      if (!sameCheckpoint(state.hoveredCheckpoint, checkpoint)) {
        update({ hoveredCheckpoint: checkpoint });
      }
    },
    openCheckpoint: (checkpoint) => {
      if (sameCheckpoint(state.openCheckpoint, checkpoint)) return;
      update(
        checkpoint === null
          ? { openCheckpoint: null }
          : { openCheckpoint: checkpoint, selectedRouteId: checkpoint.routeId },
      );
    },
    setFrame,
    stepFrame: (delta) => {
      setFrame(state.sliderFrame + delta);
    },
    setField: (field) => {
      update({ heatmapField: field });
    },
    setHeatmapVisible: (visible) => {
      update({ heatmapVisible: visible });
    },
    play: () => {
      update({ playing: true });
    },
    pause: () => {
      update({ playing: false });
    },
    toggle: () => {
      update({ playing: !state.playing });
    },
    resetForPlan: (plan) => {
      const recommended =
        plan.routes.find((route) => route.recommended)?.route_id ?? plan.recommendation.route_id;
      update({
        selectedRouteId: recommended,
        hoveredCheckpoint: null,
        openCheckpoint: null,
        sliderFrame: 0,
        playing: false,
      });
    },
  };

  return {
    getState: () => state,
    getInitialState: () => initialState,
    subscribe: (listener) => {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((candidate) => candidate !== listener);
      };
    },
    actions,
  };
}

/** The store the app shares (the map card and the planner/results card both use it). */
export const tripStore: TripStore = createTripStore();

/**
 * Subscribes to a derived value; the selector must return a primitive or a stable reference (a
 * selector that builds a new object on every call never settles and React stops rendering). Server
 * renders read the store's initial state.
 */
export function useTripState<T>(
  selector: (state: TripState) => T,
  store: TripStore = tripStore,
): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getInitialState()),
  );
}

/** The selected route id; unaffected by slider ticks and hover. */
export function useSelectedRouteId(store: TripStore = tripStore): string | null {
  return useTripState((state) => state.selectedRouteId, store);
}

/** The hovered checkpoint (stable object while unchanged). */
export function useHoveredCheckpoint(store: TripStore = tripStore): CheckpointRef | null {
  return useTripState((state) => state.hoveredCheckpoint, store);
}

/** The checkpoint whose details are open (stable object while unchanged). */
export function useOpenCheckpoint(store: TripStore = tripStore): CheckpointRef | null {
  return useTripState((state) => state.openCheckpoint, store);
}

/** Whether the heatmap is shown. */
export function useHeatmapVisible(store: TripStore = tripStore): boolean {
  return useTripState((state) => state.heatmapVisible, store);
}

/** The forecast hour on the slider (0..48). */
export function useSliderFrame(store: TripStore = tripStore): number {
  return useTripState((state) => state.sliderFrame, store);
}

/** The heatmap layer. */
export function useHeatmapField(store: TripStore = tripStore): HeatmapLayer {
  return useTripState((state) => state.heatmapField, store);
}

/** Whether the forecast animation is playing. */
export function usePlaying(store: TripStore = tripStore): boolean {
  return useTripState((state) => state.playing, store);
}

/** The store's actions (stable identity). */
export function useTripActions(store: TripStore = tripStore): TripActions {
  return useMemo(() => store.actions, [store]);
}
