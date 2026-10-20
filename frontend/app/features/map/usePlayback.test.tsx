import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTripStore } from "../../state/trip-store";
import { FRAME_MS, LAST_FRAME, usePlayback } from "./usePlayback";
import type { FrameClock } from "./usePlayback";

/** A clock a test advances by hand: `advance(ms)` runs one animation frame `ms` later. */
function manualClock(): FrameClock & { advance: (ms: number) => void; pending: () => number } {
  let now = 1000;
  let callbacks = new Map<number, (time: number) => void>();
  let next = 1;
  return {
    request: (callback) => {
      callbacks.set(next, callback);
      next += 1;
      return next - 1;
    },
    cancel: (handle) => {
      callbacks.delete(handle);
    },
    advance: (ms) => {
      now += ms;
      const run = callbacks;
      callbacks = new Map();
      for (const callback of run.values()) callback(now);
    },
    pending: () => callbacks.size,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("usePlayback", () => {
  it("does nothing until playing", () => {
    const store = createTripStore();
    const clock = manualClock();
    renderHook(() => {
      usePlayback(store, clock);
    });

    expect(clock.pending()).toBe(0);
  });

  it("steps one hour every 250 ms, whatever the display's refresh rate", () => {
    const store = createTripStore();
    const clock = manualClock();
    renderHook(() => {
      usePlayback(store, clock);
    });

    act(() => {
      store.actions.play();
    });
    act(() => {
      clock.advance(16);
      for (let elapsed = 0; elapsed < FRAME_MS - 16; elapsed += 16) clock.advance(16);
    });
    expect(store.getState().sliderFrame).toBe(0);
    act(() => {
      clock.advance(16);
    });
    expect(store.getState().sliderFrame).toBe(1);
  });

  it("stops at +48 h", () => {
    const store = createTripStore({ sliderFrame: LAST_FRAME - 1 });
    const clock = manualClock();
    renderHook(() => {
      usePlayback(store, clock);
    });

    act(() => {
      store.actions.play();
    });
    act(() => {
      clock.advance(0);
      clock.advance(FRAME_MS);
      clock.advance(FRAME_MS);
    });

    expect(store.getState()).toMatchObject({ sliderFrame: LAST_FRAME, playing: false });
    expect(clock.pending()).toBe(0);
  });

  it("stops the clock when paused or unmounted", () => {
    const store = createTripStore();
    const clock = manualClock();
    const { unmount } = renderHook(() => {
      usePlayback(store, clock);
    });
    act(() => {
      store.actions.play();
    });
    expect(clock.pending()).toBe(1);

    act(() => {
      store.actions.pause();
    });
    expect(clock.pending()).toBe(0);
    act(() => {
      store.actions.play();
    });
    unmount();
    expect(clock.pending()).toBe(0);
  });

  it("uses the browser's animation frames by default", () => {
    const request = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(7);
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockReturnValue();
    const store = createTripStore({ playing: true });

    const { unmount } = renderHook(() => {
      usePlayback(store);
    });
    unmount();

    expect(request).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(7);
  });
});
