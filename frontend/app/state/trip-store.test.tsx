import { act, render, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { useEffect, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { minimalPlan } from "../api/mocks/minimal";
import {
  createTripStore,
  tripStore,
  useHeatmapField,
  useHoveredCheckpoint,
  usePlaying,
  useSelectedRouteId,
  useSliderFrame,
  useTripActions,
  useTripState,
  type TripState,
} from "./index";

describe("createTripStore", () => {
  it("starts from the documented defaults and accepts overrides", () => {
    expect(createTripStore().getState()).toEqual({
      selectedRouteId: null,
      hoveredCheckpoint: null,
      sliderFrame: 0,
      heatmapField: "risk",
      playing: false,
    });
    expect(
      createTripStore({ sliderFrame: 7, heatmapField: "snow_in_hr" }).getState(),
    ).toMatchObject({
      sliderFrame: 7,
      heatmapField: "snow_in_hr",
    });
  });

  it("exports a module singleton", () => {
    expect(tripStore.getState().sliderFrame).toBe(0);
  });

  it("selects a route and clears the selection", () => {
    const store = createTripStore();
    store.actions.selectRoute("B");
    expect(store.getState().selectedRouteId).toBe("B");
    store.actions.selectRoute(null);
    expect(store.getState().selectedRouteId).toBeNull();
  });

  it("hovers a checkpoint by value and keeps the previous object while it is unchanged", () => {
    const store = createTripStore();
    store.actions.hoverCheckpoint({ routeId: "A", index: 3 });
    const first = store.getState();
    store.actions.hoverCheckpoint({ routeId: "A", index: 3 });
    expect(store.getState()).toBe(first);
    store.actions.hoverCheckpoint({ routeId: "A", index: 4 });
    expect(store.getState().hoveredCheckpoint).toEqual({ routeId: "A", index: 4 });
    store.actions.hoverCheckpoint({ routeId: "B", index: 4 });
    expect(store.getState().hoveredCheckpoint).toEqual({ routeId: "B", index: 4 });
    store.actions.hoverCheckpoint(null);
    expect(store.getState().hoveredCheckpoint).toBeNull();
    const cleared = store.getState();
    store.actions.hoverCheckpoint(null);
    expect(store.getState()).toBe(cleared);
  });

  it("sets the frame rounded and clamped to 0..48, ignoring NaN", () => {
    const store = createTripStore();
    store.actions.setFrame(12.4);
    expect(store.getState().sliderFrame).toBe(12);
    store.actions.setFrame(12.5);
    expect(store.getState().sliderFrame).toBe(13);
    store.actions.setFrame(-3);
    expect(store.getState().sliderFrame).toBe(0);
    store.actions.setFrame(99);
    expect(store.getState().sliderFrame).toBe(48);
    store.actions.setFrame(Number.POSITIVE_INFINITY);
    expect(store.getState().sliderFrame).toBe(48);
    store.actions.setFrame(Number.NEGATIVE_INFINITY);
    expect(store.getState().sliderFrame).toBe(0);
    store.actions.setFrame(5);
    store.actions.setFrame(Number.NaN);
    expect(store.getState().sliderFrame).toBe(5);
  });

  it("steps the frame without wrapping around", () => {
    const store = createTripStore({ sliderFrame: 47 });
    store.actions.stepFrame(1);
    expect(store.getState().sliderFrame).toBe(48);
    store.actions.stepFrame(1);
    expect(store.getState().sliderFrame).toBe(48);
    store.actions.stepFrame(-6);
    expect(store.getState().sliderFrame).toBe(42);
    store.actions.stepFrame(-100);
    expect(store.getState().sliderFrame).toBe(0);
  });

  it("switches the heatmap field", () => {
    const store = createTripStore();
    store.actions.setField("wind_mph");
    expect(store.getState().heatmapField).toBe("wind_mph");
  });

  it("plays, pauses and toggles, treating repeats as no-ops", () => {
    const store = createTripStore();
    store.actions.play();
    expect(store.getState().playing).toBe(true);
    const playing = store.getState();
    store.actions.play();
    expect(store.getState()).toBe(playing);
    store.actions.pause();
    expect(store.getState().playing).toBe(false);
    const paused = store.getState();
    store.actions.pause();
    expect(store.getState()).toBe(paused);
    store.actions.toggle();
    expect(store.getState().playing).toBe(true);
    store.actions.toggle();
    expect(store.getState().playing).toBe(false);
  });

  it("resets for a plan: recommended route, frame 0, paused, no hover, field kept", () => {
    const store = createTripStore({
      sliderFrame: 30,
      playing: true,
      heatmapField: "rain_in_hr",
      hoveredCheckpoint: { routeId: "A", index: 2 },
    });
    store.actions.resetForPlan(minimalPlan());
    expect(store.getState()).toEqual({
      selectedRouteId: "B",
      hoveredCheckpoint: null,
      sliderFrame: 0,
      heatmapField: "rain_in_hr",
      playing: false,
    });
  });

  it("falls back to recommendation.route_id when no route carries the flag", () => {
    const plan = structuredClone(minimalPlan());
    for (const route of plan.routes) route.recommended = false;
    const store = createTripStore();
    store.actions.resetForPlan(plan);
    expect(store.getState().selectedRouteId).toBe(plan.recommendation.route_id);
  });

  it("does not notify when a reset changes nothing", () => {
    const store = createTripStore({ selectedRouteId: "B" });
    const listener = vi.fn();
    store.subscribe(listener);
    store.actions.resetForPlan(minimalPlan());
    expect(listener).not.toHaveBeenCalled();
  });

  it("has actions that work when destructured", () => {
    const store = createTripStore();
    const { selectRoute, setFrame } = store.actions;
    selectRoute("C");
    setFrame(4);
    expect(store.getState()).toMatchObject({ selectedRouteId: "C", sliderFrame: 4 });
  });
});

describe("subscriptions", () => {
  it("notifies on change only, and stops after unsubscribe (twice is harmless)", () => {
    const store = createTripStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.actions.setFrame(1);
    store.actions.setFrame(1);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    unsubscribe();
    store.actions.setFrame(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not call a listener removed during the notification", () => {
    const store = createTripStore();
    const second = vi.fn();
    let unsubscribeSecond: () => void = () => undefined;
    store.subscribe(() => {
      unsubscribeSecond();
    });
    unsubscribeSecond = store.subscribe(second);
    store.actions.setFrame(3);
    expect(second).not.toHaveBeenCalled();
  });

  it("supports several independent listeners", () => {
    const store = createTripStore();
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    store.actions.selectRoute("A");
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);
  });
});

describe("hooks", () => {
  it("render on the server from the store's initial state, not its current one", () => {
    // `/` and `/methodology` are prerendered, so a store reader must not throw without a client.
    const store = createTripStore({ sliderFrame: 7, selectedRouteId: "B" });
    store.actions.setFrame(9);
    function Probe(): ReactElement {
      const frame = useSliderFrame(store);
      const route = useSelectedRouteId(store);
      return <p>{`${String(route)}@${String(frame)}`}</p>;
    }

    expect(renderToString(<Probe />)).toContain("B@7");
    expect(store.getInitialState().sliderFrame).toBe(7);
    expect(store.getState().sliderFrame).toBe(9);
  });

  it("read each slice of the store and follow updates", () => {
    const store = createTripStore();
    const hooks = renderHook(() => ({
      route: useSelectedRouteId(store),
      hover: useHoveredCheckpoint(store),
      frame: useSliderFrame(store),
      field: useHeatmapField(store),
      playing: usePlaying(store),
    }));
    expect(hooks.result.current).toEqual({
      route: null,
      hover: null,
      frame: 0,
      field: "risk",
      playing: false,
    });

    act(() => {
      store.actions.selectRoute("B");
      store.actions.hoverCheckpoint({ routeId: "B", index: 1 });
      store.actions.setFrame(6);
      store.actions.setField("snow_in_hr");
      store.actions.play();
    });

    expect(hooks.result.current).toEqual({
      route: "B",
      hover: { routeId: "B", index: 1 },
      frame: 6,
      field: "snow_in_hr",
      playing: true,
    });
  });

  it("default to the module singleton", () => {
    tripStore.actions.setFrame(9);
    const { result } = renderHook(() => useSliderFrame());
    expect(result.current).toBe(9);
    tripStore.actions.setFrame(0);
  });

  it("selects any derived value with useTripState", () => {
    const store = createTripStore({ sliderFrame: 12 });
    const { result } = renderHook(() =>
      useTripState((state: TripState) => state.sliderFrame * 2, store),
    );
    expect(result.current).toBe(24);
  });

  it("gives stable actions that drive the store", () => {
    const store = createTripStore();
    const { result, rerender } = renderHook(() => useTripActions(store));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    act(() => {
      result.current.stepFrame(5);
    });
    expect(store.getState().sliderFrame).toBe(5);
    const singleton = renderHook(() => useTripActions());
    expect(singleton.result.current).toBe(tripStore.actions);
  });

  it("a slider tick never re-renders a component that only reads the selected route", () => {
    const store = createTripStore({ selectedRouteId: "A" });
    const renders = { panel: 0, slider: 0 };
    function Panel(): ReactElement {
      renders.panel += 1;
      return <p>{useSelectedRouteId(store)}</p>;
    }
    function Slider(): ReactElement {
      renders.slider += 1;
      const frame = useSliderFrame(store);
      useEffect(() => undefined, [frame]);
      return <p>{frame}</p>;
    }
    render(
      <>
        <Panel />
        <Slider />
      </>,
    );
    const panelAfterMount = renders.panel;
    const sliderAfterMount = renders.slider;

    for (let frame = 1; frame <= 10; frame += 1) {
      act(() => {
        store.actions.setFrame(frame);
      });
    }

    expect(renders.panel).toBe(panelAfterMount);
    expect(renders.slider).toBe(sliderAfterMount + 10);
  });
});

describe("frame properties", () => {
  it("any sequence of setFrame/stepFrame keeps the frame an integer in 0..48", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.boolean(), fc.double({ noDefaultInfinity: false })), {
          maxLength: 60,
        }),
        (operations) => {
          const store = createTripStore();
          for (const [step, value] of operations) {
            if (step) store.actions.stepFrame(value);
            else store.actions.setFrame(value);
            const { sliderFrame } = store.getState();
            expect(Number.isInteger(sliderFrame) && sliderFrame >= 0 && sliderFrame <= 48).toBe(
              true,
            );
          }
        },
      ),
    );
  });

  it("hovering the same checkpoint twice never changes the state identity the second time", () => {
    fc.assert(
      fc.property(fc.string(), fc.nat(), (routeId, index) => {
        const store = createTripStore();
        store.actions.hoverCheckpoint({ routeId, index });
        const before = store.getState();
        store.actions.hoverCheckpoint({ routeId, index });
        expect(store.getState()).toBe(before);
      }),
    );
  });
});
