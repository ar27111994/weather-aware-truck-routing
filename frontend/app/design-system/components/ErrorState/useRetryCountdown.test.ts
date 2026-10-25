import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeRetryAfter, useRetryCountdown } from "./useRetryCountdown";

/** The longest wait the countdown shows: a day. A server that asks for more gets this. */
const ONE_DAY = 24 * 60 * 60;

describe("normalizeRetryAfter", () => {
  it.each([
    [undefined, 0],
    [Number.NaN, 0],
    [0, 0],
    [-3, 0],
    [Number.NEGATIVE_INFINITY, 0],
    [0.2, 1],
    [2.5, 3],
    [7, 7],
    [ONE_DAY, ONE_DAY],
    [ONE_DAY + 1, ONE_DAY],
    [1e300, ONE_DAY],
    [Number.POSITIVE_INFINITY, ONE_DAY],
  ])("turns %s into %s whole seconds", (input, expected) => {
    expect(normalizeRetryAfter(input)).toBe(expected);
  });
});

describe("useRetryCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts at the given seconds and counts down once a second", () => {
    const { result } = renderHook(() => useRetryCountdown(3));
    expect(result.current).toBe(3);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(2);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe(0);
  });

  it("stops at 0 and leaves no timer behind", () => {
    const { result } = renderHook(() => useRetryCountdown(2));

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(result.current).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, 0])("does nothing for %s", (seconds) => {
    const { result } = renderHook(() => useRetryCountdown(seconds));

    expect(result.current).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts from the new value when the input changes", () => {
    const { result, rerender } = renderHook(({ seconds }) => useRetryCountdown(seconds), {
      initialProps: { seconds: 2 },
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe(0);

    rerender({ seconds: 10 });
    expect(result.current).toBe(10);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(9);
  });

  it("keeps counting across re-renders with the same input", () => {
    const { result, rerender } = renderHook(({ seconds }) => useRetryCountdown(seconds), {
      initialProps: { seconds: 5 },
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    rerender({ seconds: 5 });

    expect(result.current).toBe(3);
  });

  it("clears its timer on unmount", () => {
    const { unmount } = renderHook(() => useRetryCountdown(5));
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  describe("an input that is not a whole number of seconds", () => {
    it("does nothing for NaN, and does not re-render itself without end", () => {
      const { result } = renderHook(() => useRetryCountdown(Number.NaN));

      expect(result.current).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("ends a running countdown when the input becomes NaN", () => {
      const { result, rerender } = renderHook(({ seconds }) => useRetryCountdown(seconds), {
        initialProps: { seconds: 5 },
      });

      rerender({ seconds: Number.NaN });

      expect(result.current).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([-1, -0.5, Number.NEGATIVE_INFINITY])("treats %s as nothing to wait for", (seconds) => {
      const { result } = renderHook(() => useRetryCountdown(seconds));

      expect(result.current).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rounds a fraction up, so a retry never fires early", () => {
      const { result } = renderHook(() => useRetryCountdown(2.5));
      expect(result.current).toBe(3);

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(result.current).toBe(2);

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(result.current).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([Number.POSITIVE_INFINITY, 1e300, Number.MAX_SAFE_INTEGER])(
      "caps %s at one day, and counts that down",
      (seconds) => {
        const { result } = renderHook(() => useRetryCountdown(seconds));
        expect(result.current).toBe(ONE_DAY);

        act(() => {
          vi.advanceTimersByTime(1000);
        });

        expect(result.current).toBe(ONE_DAY - 1);
      },
    );
  });

  it("counts down to a deadline: after a sleep, the next tick shows the time really left", () => {
    const { result } = renderHook(() => useRetryCountdown(10));

    // A tab in the background gets its timers late, or not at all. Nothing ran for 6 s here: the
    // clock moved, no tick came. A count of ticks would show 9 at the next tick; the deadline
    // is 10 s from the start, and 7 s of them are gone.
    vi.setSystemTime(Date.now() + 6000);
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(result.current).toBe(3);
  });

  it("is over, with no timer left, when a tick comes after the deadline", () => {
    const { result } = renderHook(() => useRetryCountdown(2));

    vi.setSystemTime(Date.now() + 60_000);
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(result.current).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
