import { Map as MapLibreMap } from "maplibre-gl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeMaps, fakeMarkers, resetFakes } from "../../../test/fake-maplibre";
import type { FakeMap } from "../../../test/fake-maplibre";
import type { Plan } from "../../api/contract";
import { buildHeatmap, buildPlan, minimalPlan } from "../../api/mocks";
import { at } from "../../lib/checked";
import { positionAtDistance } from "../../lib/geo";
import { basemapStyleUrl } from "./basemap";
import { checkpointFeatureId } from "./features";
import { decodeHeatmap, heatmapPaint } from "./heatmap";
import {
  CAMERA_DURATION_MS,
  LAYERS,
  MapController,
  PLAN_LAYERS,
  SOURCES,
  floorToHour,
} from "./map-controller";
import type { MapControllerOptions, PlanMarkerElements } from "./map-controller";
import { palette } from "./symbology";
import { truckPositions } from "./truck";

vi.mock("maplibre-gl", () => import("../../../test/fake-maplibre"));

/** A basemap with the layer kinds the anchors look for. */
const BASEMAP = [
  { id: "background", type: "background" },
  { id: "water", type: "fill", "source-layer": "water" },
  { id: "tunnel_motorway_casing", type: "line", "source-layer": "transportation" },
  { id: "highway_motorway_casing", type: "line", "source-layer": "transportation" },
  { id: "water_name_point_label", type: "symbol", "source-layer": "water_name" },
  { id: "place_city", type: "symbol", "source-layer": "place" },
];

const PLAN: Plan = buildPlan({ ...minimalPlan().request, scenario: "mixed" });
const HEATMAP = buildHeatmap(PLAN);

function elementsFor(plan: Plan): PlanMarkerElements {
  const make = (): HTMLElement => document.createElement("div");
  return {
    origin: make(),
    destination: make(),
    routes: plan.routes.map(() => ({ plate: make(), truck: make() })),
  };
}

/** The plate and truck elements of `routeId` (by its position in {@link PLAN}). */
function slotsOf(
  elements: PlanMarkerElements,
  routeId: string,
): PlanMarkerElements["routes"][number] {
  return at(
    elements.routes,
    PLAN.routes.findIndex((route) => route.route_id === routeId),
  );
}

function plateOf(elements: PlanMarkerElements, routeId: string): HTMLElement {
  return slotsOf(elements, routeId).plate;
}

function truckOf(elements: PlanMarkerElements, routeId: string): HTMLElement {
  return slotsOf(elements, routeId).truck;
}

interface Rig {
  readonly fake: FakeMap;
  readonly controller: MapController;
  readonly options: MapControllerOptions;
  /** Runs every animation frame the controller asked for. */
  readonly flushFrames: () => number;
  readonly cancelFrame: ReturnType<typeof vi.fn>;
}

function rig(overrides: Partial<MapControllerOptions> = {}): Rig {
  const container = document.createElement("div");
  document.body.append(container);
  const map = new MapLibreMap({ container, style: basemapStyleUrl("light") });
  const fake = at(fakeMaps, fakeMaps.length - 1);
  let queue: (() => void)[] = [];
  const cancelFrame = vi.fn();
  const options: MapControllerOptions = {
    theme: "light",
    styleFor: basemapStyleUrl,
    isReducedMotion: () => false,
    pixelRatio: 2,
    etaLabel: (checkpoint) => `ETA ${String(checkpoint.index)}`,
    renderIcon: (key) => ({ width: 1, height: 1, data: new Uint8Array([key.length, 0, 0, 255]) }),
    requestFrame: (callback) => {
      queue.push(callback);
      return queue.length;
    },
    cancelFrame,
    onSelectRoute: vi.fn(),
    onHoverCheckpoint: vi.fn(),
    onOpenCheckpoint: vi.fn(),
    onStyleReady: vi.fn(),
    ...overrides,
  };
  const controller = new MapController(map, options);
  const flushFrames = (): number => {
    const run = queue;
    queue = [];
    for (const callback of run) callback();
    return run.length;
  };
  return { fake, controller, options, flushFrames, cancelFrame };
}

function cellState(fake: FakeMap, cell: number): unknown {
  return fake.getFeatureState({ source: SOURCES.heatmap, id: cell })["v"];
}

beforeEach(() => {
  resetFakes();
});

describe("style loading", () => {
  it("waits for the style, then adds the marker images, the basemap overrides, our sources and layers in order", () => {
    const { fake, controller, options } = rig();
    controller.setPlan(PLAN, elementsFor(PLAN));
    controller.setHeatmap(HEATMAP);
    expect(fake.sources.size).toBe(0);

    fake.loadStyle(BASEMAP);

    expect([...fake.images.keys()]).toEqual([
      "hc-cp-low",
      "hc-cp-moderate",
      "hc-cp-high",
      "hc-cp-severe",
      "hc-cp-no_travel",
      "hc-cp-unknown",
    ]);
    expect(fake.images.get("hc-cp-low")?.options).toEqual({ pixelRatio: 2 });
    expect([...fake.sources.keys()].sort()).toEqual(Object.values(SOURCES).sort());
    expect(fake.layerIds()).toEqual([
      "background",
      "water",
      LAYERS.heatmap,
      "tunnel_motorway_casing",
      "highway_motorway_casing",
      ...PLAN_LAYERS.slice(0, 7),
      "water_name_point_label",
      "place_city",
      ...PLAN_LAYERS.slice(7),
    ]);
    expect(fake.getLayer("water_name_point_label")?.paint["text-color"]).toBe(
      palette("light")["map-basemap-label-override"],
    );
    expect(options.onStyleReady).toHaveBeenCalledTimes(1);
  });

  it("draws the heatmap's first frame and the risk paint as soon as the layer exists", () => {
    const { fake, controller } = rig();
    controller.setHeatmap(HEATMAP);
    fake.loadStyle(BASEMAP);

    const frames = decodeHeatmap(HEATMAP);
    const first = frames.frame("risk", 0);
    HEATMAP.cells.forEach((cell, position) => {
      expect(cellState(fake, cell)).toBe(first[position]);
    });
    expect(fake.getLayer(LAYERS.heatmap)?.paint["fill-color"]).toEqual(
      heatmapPaint("risk", "light")["fill-color"],
    );
    expect(fake.getLayer(LAYERS.heatmap)?.layout["visibility"]).toBe("visible");
  });

  it("re-creates everything after a theme switch, in the new theme's colours, with the current frame", () => {
    const { fake, controller, flushFrames } = rig();
    controller.setPlan(PLAN, elementsFor(PLAN));
    controller.setHeatmap(HEATMAP);
    fake.loadStyle(BASEMAP);
    controller.setFrame(9);
    flushFrames();

    controller.setTheme("dark");
    expect(fake.styleUrl).toBe(basemapStyleUrl("dark"));
    expect(fake.styleOptions).toEqual({ diff: false });
    fake.loadStyle(BASEMAP);

    expect(fake.getLayer(LAYERS.casing)?.paint["line-color"]).toBe(
      palette("dark")["map-route-casing"],
    );
    expect(fake.getLayer(LAYERS.heatmap)?.paint["fill-color"]).toEqual(
      heatmapPaint("risk", "dark")["fill-color"],
    );
    const ninth = decodeHeatmap(HEATMAP).frame("risk", 9);
    expect(cellState(fake, at(HEATMAP.cells, 0))).toBe(ninth[0]);
    expect(fake.getLayer("place_city")?.paint["text-halo-color"]).toBe(
      palette("dark")["map-basemap-label-halo-override"],
    );
  });

  it("does not reload the style for the theme it already shows", () => {
    const { fake, controller } = rig();
    fake.styleUrl = "unchanged";

    controller.setTheme("light");

    expect(fake.styleUrl).toBe("unchanged");
  });
});

describe("selection", () => {
  it("splits every route layer into the selected route on top and the others underneath", () => {
    const { fake, controller } = rig();
    controller.setPlan(PLAN, elementsFor(PLAN));
    fake.loadStyle(BASEMAP);

    controller.setSelectedRoute("B");

    expect(fake.getLayer(LAYERS.casingSelected)?.filter).toEqual(["==", ["get", "route_id"], "B"]);
    expect(fake.getLayer(LAYERS.casing)?.filter).toEqual(["!=", ["get", "route_id"], "B"]);
    expect(fake.getLayer(LAYERS.ribbonUnknownSelected)?.filter).toEqual([
      "all",
      ["==", ["get", "route_id"], "B"],
      ["==", ["get", "level"], "unknown"],
    ]);
    expect(fake.getLayer(LAYERS.ribbon)?.filter).toEqual([
      "all",
      ["!=", ["get", "route_id"], "B"],
      ["!=", ["get", "level"], "unknown"],
    ]);
    expect(fake.getLayer(LAYERS.checkpointsSelected)?.filter).toEqual([
      "==",
      ["get", "route_id"],
      "B",
    ]);
  });

  it("mutes every route when nothing is selected", () => {
    const { fake, controller } = rig();
    controller.setPlan(PLAN, elementsFor(PLAN));
    fake.loadStyle(BASEMAP);

    expect(fake.getLayer(LAYERS.outline)?.filter).toEqual(["==", ["get", "route_id"], ""]);
  });

  it("marks the selected route's plate and truck and stacks them above the others", () => {
    const { controller } = rig();
    const elements = elementsFor(PLAN);
    controller.setPlan(PLAN, elements);

    controller.setSelectedRoute("A");

    const plateA = plateOf(elements, "A");
    const plateB = plateOf(elements, "B");
    expect(plateA.dataset["selected"]).toBe("true");
    expect(plateB.dataset["selected"]).toBe("false");
    expect(truckOf(elements, "A").style.zIndex).toBe("4");
    expect(truckOf(elements, "B").style.zIndex).toBe("3");
    expect(plateA.style.zIndex).toBe("2");
  });

  it("does nothing when the same route is selected again", () => {
    const { fake, controller } = rig();
    controller.setPlan(PLAN, elementsFor(PLAN));
    fake.loadStyle(BASEMAP);
    controller.setSelectedRoute("A");
    const setFilter = vi.spyOn(fake, "setFilter");

    controller.setSelectedRoute("A");

    expect(setFilter).not.toHaveBeenCalled();
  });
});

describe("heatmap frames", () => {
  it("writes at most one frame per animation frame, and only the cells that changed", () => {
    const { fake, controller, flushFrames } = rig();
    controller.setHeatmap(HEATMAP);
    fake.loadStyle(BASEMAP);
    const writesAfterLoad = fake.featureStateWrites;

    controller.setFrame(3);
    controller.setFrame(12);
    expect(fake.featureStateWrites).toBe(writesAfterLoad);
    expect(flushFrames()).toBe(1);

    const frames = decodeHeatmap(HEATMAP);
    const twelve = frames.frame("risk", 12);
    HEATMAP.cells.forEach((cell, position) => {
      expect(cellState(fake, cell)).toBe(twelve[position]);
    });
    const changed = Array.from(twelve).filter(
      (value, position) => value !== frames.frame("risk", 0)[position],
    );
    expect(fake.featureStateWrites - writesAfterLoad).toBe(changed.length);
  });

  it("switches the layer with a paint change and rewrites every cell from the new layer", () => {
    const { fake, controller } = rig();
    controller.setHeatmap(HEATMAP);
    fake.loadStyle(BASEMAP);
    const writes = fake.featureStateWrites;

    controller.setField("wind_mph");

    expect(fake.getLayer(LAYERS.heatmap)?.paint["fill-color"]).toEqual(
      heatmapPaint("wind_mph", "light")["fill-color"],
    );
    expect(fake.getLayer(LAYERS.heatmap)?.paint["fill-opacity"]).toEqual(
      heatmapPaint("wind_mph", "light")["fill-opacity"],
    );
    expect(fake.featureStateWrites - writes).toBe(HEATMAP.cells.length);
    expect(cellState(fake, at(HEATMAP.cells, 0))).toBe(
      decodeHeatmap(HEATMAP).frame("wind_mph", 0)[0],
    );
    expect(fake.sources.get(SOURCES.heatmap)?.setDataCalls).toBe(0);
  });

  it("remembers a layer chosen before the heatmap arrives, and ignores a repeat", () => {
    const { fake, controller } = rig();
    controller.setField("snow_in_hr");
    controller.setField("snow_in_hr");
    controller.setHeatmap(HEATMAP);
    fake.loadStyle(BASEMAP);

    expect(fake.paintCalls.filter((call) => call.layer === LAYERS.heatmap)).toEqual([]);
    expect(fake.getLayer(LAYERS.heatmap)?.paint["fill-color"]).toEqual(
      heatmapPaint("snow_in_hr", "light")["fill-color"],
    );
  });

  it("hides and shows the layer, remembering the choice across a reload", () => {
    const { fake, controller } = rig();
    controller.setHeatmapVisible(false);
    controller.setHeatmap(HEATMAP);
    fake.loadStyle(BASEMAP);
    expect(fake.getLayer(LAYERS.heatmap)?.layout["visibility"]).toBe("none");

    controller.setHeatmapVisible(true);
    controller.setHeatmapVisible(true);
    expect(fake.getLayer(LAYERS.heatmap)?.layout["visibility"]).toBe("visible");

    controller.setHeatmapVisible(false);
    expect(fake.getLayer(LAYERS.heatmap)?.layout["visibility"]).toBe("none");
  });

  it("removes the layer when the heatmap goes, and replaces it when a new one comes", () => {
    const { fake, controller } = rig();
    controller.setHeatmap(HEATMAP);
    controller.setHeatmap(HEATMAP);
    fake.loadStyle(BASEMAP);

    controller.setHeatmap(undefined);
    expect(fake.getLayer(LAYERS.heatmap)).toBeUndefined();
    expect(fake.getSource(SOURCES.heatmap)).toBeUndefined();

    controller.setHeatmap(HEATMAP);
    controller.setHeatmap(HEATMAP);
    expect(fake.layerIds().filter((id) => id === LAYERS.heatmap)).toHaveLength(1);
  });
});

describe("markers", () => {
  it("pins the origin and destination and puts each route's plate along it, offset by rank", () => {
    const { controller } = rig();
    const elements = elementsFor(PLAN);

    controller.setPlan(PLAN, elements);

    const [first, second] = PLAN.routes;
    if (!first || !second) throw new Error("the plan has two routes");
    const marker = (element: HTMLElement | undefined): (typeof fakeMarkers)[number] | undefined =>
      fakeMarkers.find((candidate) => candidate.element === element);
    expect(marker(elements.origin)?.lngLat).toEqual(first.geometry.coordinates[0]);
    expect(marker(elements.destination)?.lngLat).toEqual(first.geometry.coordinates.at(-1));
    expect(marker(plateOf(elements, first.route_id))?.lngLat).toEqual(
      positionAtDistance(first.geometry.coordinates, first.cumulative_mi, first.distance_mi * 0.5),
    );
    expect(marker(plateOf(elements, second.route_id))?.lngLat).toEqual(
      positionAtDistance(
        second.geometry.coordinates,
        second.cumulative_mi,
        second.distance_mi * 0.4,
      ),
    );
  });

  it("moves each truck to its position at the frame's time and hides it off the road", () => {
    const { controller, flushFrames } = rig();
    const elements = elementsFor(PLAN);
    controller.setPlan(PLAN, elements);
    controller.setHeatmap(HEATMAP);
    const start = Date.parse(HEATMAP.start_time);

    controller.setFrame(2);
    flushFrames();

    for (const truck of truckPositions(PLAN, start, 2)) {
      const element = truckOf(elements, truck.routeId);
      const marker = fakeMarkers.find((candidate) => candidate.element === element);
      expect(element.hidden).toBe(false);
      expect(marker?.lngLat).toEqual(truck.position);
    }

    controller.setFrame(48);
    flushFrames();
    for (const { truck: element } of elements.routes) expect(element.hidden).toBe(true);
  });

  it("times the trucks from the departure hour when there is no heatmap yet", () => {
    const { controller, flushFrames } = rig();
    const elements = elementsFor(PLAN);
    controller.setPlan(PLAN, elements);

    controller.setFrame(1);
    flushFrames();

    const start = floorToHour(Date.parse(PLAN.request.departure_time));
    const [truck] = truckPositions(PLAN, start, 1);
    const element = truckOf(elements, truck?.routeId ?? "");
    expect(fakeMarkers.find((candidate) => candidate.element === element)?.lngLat).toEqual(
      truck?.position,
    );
  });

  it("replaces the previous plan's layers and markers when a new plan arrives", () => {
    const { fake, controller } = rig();
    const before = elementsFor(PLAN);
    controller.setPlan(PLAN, before);
    fake.loadStyle(BASEMAP);

    const next = minimalPlan();
    controller.setPlan(next, elementsFor(next));

    expect(fake.layerIds().filter((id) => id === LAYERS.casing)).toHaveLength(1);
    expect(fake.getSource(SOURCES.routes)?.data).toEqual(
      expect.objectContaining({ type: "FeatureCollection" }),
    );
    expect(fakeMarkers.filter((marker) => marker.removed)).toHaveLength(2 + PLAN.routes.length * 2);
    expect(before.origin.isConnected).toBe(false);
  });

  it("refuses a plan whose marker elements leave a route out", () => {
    const { controller } = rig();
    const elements = elementsFor(PLAN);

    expect(() => {
      controller.setPlan(PLAN, { ...elements, routes: [] });
    }).toThrow(/out of range/);
  });
});

describe("pointer events", () => {
  function loaded(): Rig {
    const setup = rig();
    setup.controller.setPlan(PLAN, elementsFor(PLAN));
    setup.fake.loadStyle(BASEMAP);
    return setup;
  }

  it("selects the route the user clicks", () => {
    const { fake, options } = loaded();

    fake.fire("click", { features: [{ properties: { route_id: "C" } }] }, LAYERS.casing);
    fake.fire("click", {}, LAYERS.casingSelected);

    expect(options.onSelectRoute).toHaveBeenCalledTimes(1);
    expect(options.onSelectRoute).toHaveBeenCalledWith("C");
  });

  it("widens the route under the pointer through feature-state, one route at a time", () => {
    const { fake } = loaded();
    const hover = (id: number): boolean | undefined =>
      fake.getFeatureState({ source: SOURCES.routes, id })["hover"] as boolean | undefined;

    fake.fire("mousemove", { features: [{ id: 1, properties: {} }] }, LAYERS.casing);
    const writes = fake.featureStateWrites;
    fake.fire("mousemove", { features: [{ id: 1, properties: {} }] }, LAYERS.casing);
    expect(fake.featureStateWrites).toBe(writes);
    expect(hover(1)).toBe(true);
    expect(fake.canvas.style.cursor).toBe("pointer");

    fake.fire("mousemove", { features: [{ id: 2, properties: {} }] }, LAYERS.casing);
    expect(hover(1)).toBe(false);
    expect(hover(2)).toBe(true);

    fake.fire("mouseleave", {}, LAYERS.casing);
    expect(hover(2)).toBe(false);
    expect(fake.canvas.style.cursor).toBe("");
  });

  it("ignores a hover without a feature id, and one that lands while the style reloads", () => {
    const { fake, controller } = loaded();
    const writes = fake.featureStateWrites;

    fake.fire("mousemove", { features: [{ properties: {} }] }, LAYERS.casing);
    controller.setTheme("dark");
    fake.fire("mousemove", { features: [{ id: 0, properties: {} }] }, LAYERS.casing);

    expect(fake.featureStateWrites).toBe(writes);
  });

  it("opens the checkpoint the user clicks and reports the one under the pointer", () => {
    const { fake, options } = loaded();
    const checkpoint = { properties: { route_id: "A", index: 4 } };

    fake.fire("click", { features: [checkpoint] }, LAYERS.checkpointsSelected);
    fake.fire("click", { features: [{ properties: { route_id: "A" } }] }, LAYERS.checkpoints);
    fake.fire("mousemove", { features: [checkpoint] }, LAYERS.checkpoints);
    expect(fake.canvas.style.cursor).toBe("pointer");
    fake.fire("mouseleave", {}, LAYERS.checkpoints);

    expect(options.onOpenCheckpoint).toHaveBeenCalledTimes(1);
    expect(options.onOpenCheckpoint).toHaveBeenCalledWith({ routeId: "A", index: 4 });
    expect(options.onHoverCheckpoint).toHaveBeenNthCalledWith(1, { routeId: "A", index: 4 });
    expect(options.onHoverCheckpoint).toHaveBeenNthCalledWith(2, null);
    expect(fake.canvas.style.cursor).toBe("");
  });
});

describe("checkpoint highlight", () => {
  it("rings the hovered and the open checkpoint through feature-state, and moves the ring with them", () => {
    const { fake, controller } = rig();
    controller.setPlan(PLAN, elementsFor(PLAN));
    controller.setOpenCheckpoint({ routeId: "B", index: 2 });
    fake.loadStyle(BASEMAP);
    const active = (position: number, index: number): unknown =>
      fake.getFeatureState({
        source: SOURCES.checkpoints,
        id: checkpointFeatureId(position, index),
      })["active"];
    const positionOf = (routeId: string): number =>
      PLAN.routes.findIndex((route) => route.route_id === routeId);

    expect(active(positionOf("B"), 2)).toBe(true);

    controller.setHoveredCheckpoint({ routeId: "A", index: 3 });
    expect(active(positionOf("A"), 3)).toBe(true);

    controller.setOpenCheckpoint(null);
    controller.setHoveredCheckpoint({ routeId: "Z", index: 1 });
    expect(active(positionOf("B"), 2)).toBe(false);
    expect(active(positionOf("A"), 3)).toBe(false);
  });
});

describe("camera", () => {
  it("fits every route inside the padding, animated unless motion is reduced", () => {
    const animated = rig();
    animated.controller.fitRoutes({ top: 1, right: 2, bottom: 3, left: 4 });
    expect(animated.fake.cameraCalls).toEqual([]);
    animated.controller.setPlan(PLAN, elementsFor(PLAN));
    animated.controller.fitRoutes({ top: 1, right: 2, bottom: 3, left: 4 });

    const still = rig({ isReducedMotion: () => true });
    still.controller.setPlan(PLAN, elementsFor(PLAN));
    still.controller.fitRoutes({ top: 0, right: 0, bottom: 0, left: 0 });

    expect(animated.fake.cameraCalls).toEqual([
      {
        method: "fitBounds",
        args: [
          expect.any(Array),
          {
            padding: { top: 1, right: 2, bottom: 3, left: 4 },
            duration: CAMERA_DURATION_MS,
            maxZoom: 10,
          },
        ],
      },
    ]);
    expect(still.fake.cameraCalls[0]?.args[1]).toMatchObject({ duration: 0 });
  });

  it("brings a checkpoint into view: eased, or a jump when motion is reduced", () => {
    const animated = rig();
    animated.controller.setPlan(PLAN, elementsFor(PLAN));
    const route = at(PLAN.routes, 0);
    const checkpoint = at(route.checkpoints, 3);

    animated.controller.focusCheckpoint({ routeId: route.route_id, index: checkpoint.index });
    animated.controller.focusCheckpoint({ routeId: route.route_id, index: 9999 });
    animated.controller.focusCheckpoint({ routeId: "Z", index: 0 });

    const still = rig({ isReducedMotion: () => true });
    still.controller.setPlan(PLAN, elementsFor(PLAN));
    still.controller.focusCheckpoint({ routeId: route.route_id, index: checkpoint.index });

    expect(animated.fake.cameraCalls).toEqual([
      {
        method: "easeTo",
        args: [{ center: [checkpoint.lon, checkpoint.lat], duration: CAMERA_DURATION_MS }],
      },
    ]);
    expect(still.fake.cameraCalls).toEqual([
      { method: "jumpTo", args: [{ center: [checkpoint.lon, checkpoint.lat] }] },
    ]);
  });
});

describe("destroy", () => {
  it("removes every listener and marker and cancels a pending frame", () => {
    const { fake, controller, cancelFrame } = rig();
    controller.setPlan(PLAN, elementsFor(PLAN));
    expect(fake.listenerCount()).toBeGreaterThan(0);
    controller.setFrame(4);

    controller.destroy();

    expect(fake.listenerCount()).toBe(0);
    expect(cancelFrame).toHaveBeenCalledTimes(1);
    expect(fakeMarkers.every((marker) => marker.removed)).toBe(true);
  });

  it("has nothing to cancel when no frame is pending", () => {
    const { controller, cancelFrame } = rig();

    controller.destroy();

    expect(cancelFrame).not.toHaveBeenCalled();
  });
});

describe("floorToHour", () => {
  it("floors to the start of the UTC hour", () => {
    expect(floorToHour(Date.parse("2026-10-20T14:59:59.999Z"))).toBe(
      Date.parse("2026-10-20T14:00:00Z"),
    );
  });
});
