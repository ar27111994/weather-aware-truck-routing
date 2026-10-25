import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { elapse, installFakeTimers } from "../../../test/fake-timers";
import { useScrollDispatch } from "./useScrollDispatch";

/** A scroll event as the browser sends it for an element: it does not bubble. */
function scrollOf(element: Element): void {
  element.dispatchEvent(new Event("scroll"));
}

describe("useScrollDispatch", () => {
  beforeEach(() => {
    installFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is down until something scrolls", () => {
    const { result } = renderHook(() => useScrollDispatch());

    expect(result.current.current).toBe(false);
  });

  it("is up when an element scrolls, although that scroll event does not bubble", () => {
    const inner = document.body.appendChild(document.createElement("div"));
    const { result } = renderHook(() => useScrollDispatch());

    scrollOf(inner);

    expect(result.current.current).toBe(true);
    inner.remove();
  });

  it("comes down in the next animation frame, not before", async () => {
    const { result } = renderHook(() => useScrollDispatch());

    scrollOf(document.body);
    expect(result.current.current).toBe(true);
    await elapse(0);
    expect(result.current.current).toBe(true);

    await elapse(20);
    expect(result.current.current).toBe(false);
  });

  it("is up for a listener that the page adds after it, in the same dispatch", () => {
    const seen: boolean[] = [];
    const { result } = renderHook(() => useScrollDispatch());
    const stop = new AbortController();
    window.addEventListener("scroll", () => seen.push(result.current.current), {
      capture: true,
      signal: stop.signal,
    });

    scrollOf(document.body);
    stop.abort();

    expect(seen).toEqual([true]);
  });

  it("stops listening when the component is gone", async () => {
    const { result, unmount } = renderHook(() => useScrollDispatch());

    unmount();
    scrollOf(document.body);
    await elapse(20);

    expect(result.current.current).toBe(false);
  });
});
