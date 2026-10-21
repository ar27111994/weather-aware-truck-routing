import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from "./use-debounced-value";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function settle(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("useDebouncedValue", () => {
  it("waits at least 250 ms (R1)", () => {
    expect(SEARCH_DEBOUNCE_MS).toBeGreaterThanOrEqual(250);
  });

  it("returns the first value at once", () => {
    const { result } = renderHook(() => useDebouncedValue("den"));

    expect(result.current).toBe("den");
  });

  it("holds the old value until the new one has been still for the whole delay", () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value), {
      initialProps: { value: "den" },
    });

    rerender({ value: "denv" });
    settle(SEARCH_DEBOUNCE_MS - 1);
    expect(result.current).toBe("den");
    settle(1);

    expect(result.current).toBe("denv");
  });

  it("restarts the wait on every change, so a burst of keystrokes gives one value", () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value), {
      initialProps: { value: "d" },
    });

    for (const value of ["de", "den", "denv"]) {
      rerender({ value });
      settle(SEARCH_DEBOUNCE_MS - 50);
    }
    expect(result.current).toBe("d");
    settle(50);

    expect(result.current).toBe("denv");
  });

  it("uses the delay it is given", () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 1_000), {
      initialProps: { value: "a" },
    });

    rerender({ value: "b" });
    settle(999);
    expect(result.current).toBe("a");
    settle(1);

    expect(result.current).toBe("b");
  });

  it("drops a pending change when it unmounts", () => {
    const { rerender, unmount } = renderHook(({ value }) => useDebouncedValue(value), {
      initialProps: { value: "a" },
    });
    rerender({ value: "b" });

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
