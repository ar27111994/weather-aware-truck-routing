import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRetryCountdown } from "./useRetryCountdown";

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
});
