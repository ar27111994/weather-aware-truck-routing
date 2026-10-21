import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { allowConsole } from "../../../test/console-guard";
import {
  GPUInitializationError,
  fakeFailures,
  fakeMaps,
  fakeMarkers,
  resetFakes,
  workerUrls,
} from "../../../test/fake-maplibre";
import type { FakeMap } from "../../../test/fake-maplibre";
import { installMatchMedia } from "../../../test/match-media";
import { buildHeatmap, buildPlan, minimalPlan } from "../../api/mocks";
import { at } from "../../lib/checked";
import { createTripStore } from "../../state/trip-store";
import type { TripStore } from "../../state/trip-store";
import { basemapStyleUrl } from "./basemap";
import { checkpointFeatureId } from "./features";
import { heatmapPaint } from "./heatmap";
import { LAYERS, SOURCES } from "./map-controller";
import MapView, { DEFAULT_PADDING, REDUCED_MOTION_QUERY } from "./MapView";

vi.mock("maplibre-gl", () => import("../../../test/fake-maplibre"));

// Captured before any test resets the fakes: the module points MapLibre at its worker on import.
const WORKER_URLS_AT_IMPORT = [...workerUrls];

const PLAN = buildPlan({ ...minimalPlan().request, scenario: "mixed" });
const HEATMAP = buildHeatmap(PLAN);
const BASEMAP = [
  { id: "background", type: "background" },
  { id: "roads", type: "line", "source-layer": "transportation" },
  { id: "place_city", type: "symbol", "source-layer": "place" },
];

/** jsdom has no ResizeObserver; this one records its observers so a test can fire them. */
class FakeResizeObserver {
  static readonly instances: FakeResizeObserver[] = [];
  readonly callback: () => void;
  observed: Element[] = [];
  disconnected = false;

  constructor(callback: () => void) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.push(element);
  }

  unobserve(element: Element): void {
    this.observed = this.observed.filter((observed) => observed !== element);
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

/** A 2D context good enough for the marker images. */
function fakeContext(): CanvasRenderingContext2D {
  const noop = (): void => undefined;
  return {
    scale: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    fillText: noop,
    setLineDash: noop,
    getImageData: (_x: number, _y: number, width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
  } as unknown as CanvasRenderingContext2D;
}

let frames: (() => void)[] = [];
let cancelled: number[] = [];

beforeEach(() => {
  resetFakes();
  FakeResizeObserver.instances.length = 0;
  frames = [];
  cancelled = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => fakeContext());
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(() => {
      callback(performance.now());
    });
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
    cancelled.push(handle);
  });
  installMatchMedia();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function flushFrames(): void {
  const run = frames;
  frames = [];
  for (const frame of run) frame();
}

function theMap(): FakeMap {
  return at(fakeMaps, fakeMaps.length - 1);
}

function renderMap(
  store: TripStore = createTripStore({ selectedRouteId: at(PLAN.routes, 0).route_id }),
) {
  const view = render(
    <MapView plan={PLAN} heatmap={HEATMAP} theme="light" store={store} locale="en-US" />,
  );
  return { ...view, store };
}

function loadStyle(): void {
  act(() => {
    theMap().loadStyle(BASEMAP);
  });
}

describe("MapView", () => {
  it("ships MapLibre's worker as a same-origin asset (no blob: worker, D-25)", () => {
    expect(WORKER_URLS_AT_IMPORT).toHaveLength(1);
    expect(WORKER_URLS_AT_IMPORT[0]).toMatch(/maplibre-gl-worker/);
  });

  it("creates the map with the theme's basemap, its controls, and an accessible name and summary", () => {
    renderMap();
    const map = theMap();

    expect(map.styleUrl).toBe(basemapStyleUrl("light"));
    expect(map.options).toMatchObject({
      attributionControl: false,
      dragRotate: false,
      locale: { "Map.Title": "Route map", "NavigationControl.ZoomIn": "Zoom in" },
    });
    expect(map.controls.map((control) => control.position)).toEqual(["top-right", "bottom-right"]);
    expect(map.controls[1]?.control).toMatchObject({
      options: {
        compact: true,
        customAttribution: [
          "Map data © OpenStreetMap contributors",
          "Weather data by Open-Meteo.com (CC BY 4.0)",
        ],
      },
    });
    const summaryId = map.canvas.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(summaryId)).toHaveTextContent(
      `Plan ready. ${String(PLAN.routes.length)} routes found. Recommended: Route ${PLAN.recommendation.route_id}. Route ${at(PLAN.routes, 0).route_id} selected.`,
    );
  });

  it("summarises a plan with nothing selected without a selection sentence", () => {
    renderMap(createTripStore());

    const summaryId = theMap().canvas.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(summaryId)?.textContent).not.toMatch(/selected/);
  });

  it("frames the routes and draws routes, ribbons, checkpoints and the heatmap once the style loads", () => {
    renderMap();
    const map = theMap();

    // The first framing is a jump: MapLibre's first style load would stop an animated one.
    expect(map.cameraCalls[0]).toEqual({
      method: "fitBounds",
      args: [expect.any(Array), expect.objectContaining({ padding: DEFAULT_PADDING, duration: 0 })],
    });
    loadStyle();

    for (const layer of Object.values(LAYERS)) expect(map.getLayer(layer)).toBeDefined();
    expect(map.getContainer()).toHaveAttribute("data-style-ready", "true");
    expect(screen.getByRole("img", { name: "Origin: Salt Lake City" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Destination: Denver" })).toBeInTheDocument();
  });

  it("selects a route from its plate, and shows which plate is selected", async () => {
    const { store } = renderMap();
    const [first, second] = PLAN.routes;
    if (!first || !second) throw new Error("the plan has two routes");

    const plate = screen.getByRole("button", { name: `Select Route ${second.route_id}` });
    expect(plate).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(plate);

    expect(store.getState().selectedRouteId).toBe(second.route_id);
    expect(plate).toHaveAttribute("aria-pressed", "true");
  });

  it("follows the store without re-rendering: selection, hover, frame, layer and visibility", () => {
    const { store } = renderMap();
    loadStyle();
    const map = theMap();
    const [first, second] = PLAN.routes;
    if (!first || !second) throw new Error("the plan has two routes");

    act(() => {
      store.actions.selectRoute(second.route_id);
      store.actions.hoverCheckpoint({ routeId: second.route_id, index: 2 });
      store.actions.setField("rain_in_hr");
      store.actions.setHeatmapVisible(false);
      store.actions.setFrame(6);
    });
    flushFrames();

    expect(map.getLayer(LAYERS.casingSelected)?.filter).toEqual([
      "==",
      ["get", "route_id"],
      second.route_id,
    ]);
    expect(
      map.getFeatureState({ source: SOURCES.checkpoints, id: checkpointFeatureId(1, 2) })["active"],
    ).toBe(true);
    expect(map.getLayer(LAYERS.heatmap)?.paint["fill-color"]).toEqual(
      heatmapPaint("rain_in_hr", "light")["fill-color"],
    );
    expect(map.getLayer(LAYERS.heatmap)?.layout["visibility"]).toBe("none");
    expect(
      map.getFeatureState({ source: SOURCES.heatmap, id: at(HEATMAP.cells, 0) }),
    ).toHaveProperty("v");
  });

  it("switches the basemap with the theme and keeps everything on the new style", () => {
    const { rerender, store } = renderMap();
    loadStyle();

    rerender(<MapView plan={PLAN} heatmap={HEATMAP} theme="dark" store={store} locale="en-US" />);
    expect(theMap().styleUrl).toBe(basemapStyleUrl("dark"));
    loadStyle();

    expect(theMap().getLayer(LAYERS.ribbonSelected)).toBeDefined();
  });

  it("shows a new plan and frames it, and adds the heatmap when it arrives", () => {
    const store = createTripStore();
    const { rerender } = render(<MapView plan={PLAN} theme="light" store={store} />);
    loadStyle();
    const map = theMap();
    expect(map.getLayer(LAYERS.heatmap)).toBeUndefined();
    expect(screen.getByTestId("map-canvas-container").parentElement).toHaveAttribute(
      "data-heatmap",
      "loading",
    );

    rerender(<MapView plan={PLAN} heatmap={HEATMAP} theme="light" store={store} />);
    expect(map.getLayer(LAYERS.heatmap)).toBeDefined();

    const next = minimalPlan();
    rerender(<MapView plan={next} heatmap={HEATMAP} theme="light" store={store} />);
    const routes = map.getSource(SOURCES.routes)?.data as
      { features: { id: unknown }[] } | undefined;
    expect(routes?.features.map((feature) => feature.id)).toEqual([0, 1]);
    expect(map.cameraCalls.filter((call) => call.method === "fitBounds")).toHaveLength(2);
  });

  it("opens a checkpoint's popover where the camera settles, and closes it from the button", async () => {
    const { store } = renderMap();
    loadStyle();
    const map = theMap();
    const route = at(PLAN.routes, 0);
    const checkpoint = at(route.checkpoints, 2);

    act(() => {
      store.actions.openCheckpoint({ routeId: route.route_id, index: checkpoint.index });
    });
    expect(map.cameraCalls.at(-1)).toEqual({
      method: "easeTo",
      args: [{ center: [checkpoint.lon, checkpoint.lat], duration: 600 }],
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => {
      map.fire("moveend");
    });
    const dialog = await screen.findByRole("dialog", {
      name: `Checkpoint ${String(checkpoint.index + 1)} of ${String(route.checkpoints.length)}`,
    });
    expect(dialog).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Close checkpoint details" }));
    expect(store.getState().openCheckpoint).toBeNull();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("closes the popover with Escape and when the user moves the map, not when the camera moves itself", async () => {
    const route = at(PLAN.routes, 0);
    const ref = { routeId: route.route_id, index: at(route.checkpoints, 1).index };
    const { store } = renderMap();
    loadStyle();
    const map = theMap();
    act(() => {
      store.actions.openCheckpoint(ref);
    });
    act(() => {
      map.fire("moveend");
    });
    await screen.findByRole("dialog");

    act(() => {
      map.fire("movestart");
    });
    expect(store.getState().openCheckpoint).toEqual(ref);
    await userEvent.keyboard("{Escape}");
    expect(store.getState().openCheckpoint).toBeNull();

    act(() => {
      store.actions.openCheckpoint(ref);
    });
    act(() => {
      map.fire("movestart", { originalEvent: new MouseEvent("mousedown") });
    });
    expect(store.getState().openCheckpoint).toBeNull();
  });

  it("opens nothing for a checkpoint the plan does not have", () => {
    const { store } = renderMap(createTripStore({ openCheckpoint: { routeId: "Z", index: 0 } }));
    loadStyle();

    act(() => {
      store.actions.openCheckpoint({ routeId: "Z", index: 1 });
    });

    expect(theMap().cameraCalls.filter((call) => call.method === "easeTo")).toEqual([]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("jumps instead of easing when the user prefers reduced motion", () => {
    installMatchMedia({ [REDUCED_MOTION_QUERY]: true });
    const { store } = renderMap();
    const route = at(PLAN.routes, 0);

    act(() => {
      store.actions.openCheckpoint({
        routeId: route.route_id,
        index: at(route.checkpoints, 1).index,
      });
    });

    expect(theMap().cameraCalls.at(-1)?.method).toBe("jumpTo");
  });

  it("refits from the Fit routes button, and marks the map idle or busy", async () => {
    renderMap();
    const map = theMap();

    await userEvent.click(screen.getByRole("button", { name: "Fit routes" }));
    expect(map.cameraCalls.filter((call) => call.method === "fitBounds")).toHaveLength(2);

    act(() => {
      map.fire("idle");
    });
    expect(map.getContainer()).toHaveAttribute("data-idle", "true");
    act(() => {
      map.fire("dataloading");
    });
    expect(map.getContainer()).toHaveAttribute("data-idle", "false");
  });

  it("resizes the map with its container", () => {
    renderMap();
    const [observer] = FakeResizeObserver.instances;

    observer?.callback();

    expect(observer?.observed).toEqual([theMap().getContainer()]);
    expect(theMap().resizeCalls).toBe(1);
  });

  it("hands the map to onMap while it lives, and null once it is gone", () => {
    const onMap = vi.fn();
    const { unmount } = render(
      <MapView
        plan={PLAN}
        heatmap={HEATMAP}
        theme="light"
        store={createTripStore()}
        onMap={onMap}
      />,
    );

    expect(onMap.mock.calls).toEqual([[theMap()]]);
    unmount();
    expect(onMap.mock.calls).toEqual([[theMap()], [null]]);
  });

  it("frames the routes on the first resize that gives them room (a sheet that opens)", () => {
    fakeFailures.fit = true;
    renderMap();
    const map = theMap();
    expect(map.cameraCalls).toEqual([]);

    map.fits = true;
    FakeResizeObserver.instances[0]?.callback();

    expect(map.cameraCalls).toEqual([
      {
        method: "fitBounds",
        args: [
          expect.any(Array),
          expect.objectContaining({ padding: DEFAULT_PADDING, duration: 0 }),
        ],
      },
    ]);
  });

  it("leaves nothing behind when it unmounts: listeners, observers, frames, markers, the map", () => {
    const { unmount, store } = renderMap();
    loadStyle();
    act(() => {
      store.actions.setFrame(3);
    });
    const map = theMap();
    const subscribersBefore = vi.fn();
    store.subscribe(subscribersBefore);

    unmount();
    act(() => {
      store.actions.setFrame(9);
    });

    expect(map.removed).toBe(true);
    expect(map.listenerCount()).toBe(0);
    expect(FakeResizeObserver.instances[0]?.disconnected).toBe(true);
    expect(cancelled).toHaveLength(1);
    expect(fakeMarkers.every((marker) => marker.removed)).toBe(true);
    // Only the test's own listener still hears the store.
    expect(subscribersBefore).toHaveBeenCalledTimes(1);
    expect(theMap().featureStateWrites).toBeGreaterThan(0);
  });

  it("says the map is unavailable, and keeps the rest working, when the browser has no WebGL 2", () => {
    fakeFailures.construct = new GPUInitializationError({}, null);

    renderMap();

    expect(fakeMaps).toHaveLength(0);
    expect(screen.getByText("Map unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This browser can't draw the map. Turn on hardware acceleration or try another browser. The route details are still in the results.",
      ),
    ).toBeInTheDocument();
    // Nothing can be framed without a map, so the button goes; the plan summary stays.
    expect(screen.queryByRole("button", { name: "Fit routes" })).not.toBeInTheDocument();
    expect(screen.getByText(/^Plan ready\./)).toBeInTheDocument();
  });

  it("lets any other error from MapLibre reach the error boundary", () => {
    fakeFailures.construct = new Error("the map broke");
    allowConsole(/the map broke/);
    const caught: unknown[] = [];

    render(
      <Boundary onError={(error) => caught.push(error)}>
        <MapView
          plan={PLAN}
          heatmap={HEATMAP}
          theme="light"
          store={createTripStore()}
          locale="en-US"
        />
      </Boundary>,
    );

    expect(caught).toContain(fakeFailures.construct);
    expect(caught.every((error) => error === fakeFailures.construct)).toBe(true);
  });
});

/** Catches what its children throw, so a test can see it. */
class Boundary extends Component<{
  readonly children: ReactNode;
  readonly onError: (error: unknown) => void;
}> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError(error);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
