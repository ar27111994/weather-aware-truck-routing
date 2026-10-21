import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RECENT_PLACES_KEY,
  RECENT_PLACES_LIMIT,
  parseRecentPlaces,
  useRecentPlaces,
  withRecentPlace,
} from "./recent-places";

const place = (n: number): { lat: number; lon: number; label: string } => ({
  lat: 30 + n / 100,
  lon: -100 - n / 100,
  label: `Place ${String(n)}`,
});

afterEach(() => {
  window.localStorage.clear();
});

describe("parseRecentPlaces", () => {
  it("is empty for nothing stored", () => {
    expect(parseRecentPlaces(null)).toEqual([]);
  });

  it.each([
    ["text that is not JSON", "{not json"],
    ["JSON that is not a list", '{"label":"x"}'],
  ])("is empty for %s", (_name, raw) => {
    expect(parseRecentPlaces(raw)).toEqual([]);
  });

  it("keeps valid places in order and drops entries that are not places", () => {
    const raw = JSON.stringify([place(1), { label: "no coordinates" }, 7, null, place(2)]);

    expect(parseRecentPlaces(raw)).toEqual([place(1), place(2)]);
  });

  it("drops a repeated place and cuts the list to the limit", () => {
    const many = Array.from({ length: RECENT_PLACES_LIMIT + 4 }, (_, n) => place(n));
    const raw = JSON.stringify([place(0), ...many]);

    const places = parseRecentPlaces(raw);

    expect(places).toHaveLength(RECENT_PLACES_LIMIT);
    expect(places[0]).toEqual(place(0));
    expect(places[1]).toEqual(place(1));
  });
});

describe("withRecentPlace", () => {
  it("puts the newest place first", () => {
    expect(withRecentPlace([place(1), place(2)], place(3))).toEqual([place(3), place(1), place(2)]);
  });

  it("moves a place that was there to the front instead of repeating it", () => {
    expect(withRecentPlace([place(1), place(2), place(3)], place(2))).toEqual([
      place(2),
      place(1),
      place(3),
    ]);
  });

  it("keeps at most eight places (R1)", () => {
    const full = Array.from({ length: RECENT_PLACES_LIMIT }, (_, n) => place(n));

    const next = withRecentPlace(full, place(99));

    expect(next).toHaveLength(8);
    expect(next[0]).toEqual(place(99));
    expect(next).not.toContainEqual(place(RECENT_PLACES_LIMIT - 1));
  });

  it("refuses something that is not a valid place", () => {
    expect(() => withRecentPlace([], { lat: 200, lon: 0, label: "Off the map" })).toThrow();
  });
});

describe("useRecentPlaces", () => {
  it("starts from what the browser has stored", () => {
    window.localStorage.setItem(RECENT_PLACES_KEY, JSON.stringify([place(1)]));

    const { result } = renderHook(() => useRecentPlaces());

    expect(result.current.places).toEqual([place(1)]);
  });

  it("remembers a place, newest first, and writes it to localStorage", () => {
    const { result } = renderHook(() => useRecentPlaces());

    act(() => {
      result.current.remember(place(1));
    });
    act(() => {
      result.current.remember(place(2));
    });

    expect(result.current.places).toEqual([place(2), place(1)]);
    expect(JSON.parse(window.localStorage.getItem(RECENT_PLACES_KEY) ?? "null")).toEqual([
      place(2),
      place(1),
    ]);
  });

  it("shows the same list in every field at once", () => {
    const first = renderHook(() => useRecentPlaces());
    const second = renderHook(() => useRecentPlaces());

    act(() => {
      first.result.current.remember(place(5));
    });

    expect(second.result.current.places).toEqual([place(5)]);
  });

  it("follows a change made in another tab", () => {
    const { result } = renderHook(() => useRecentPlaces());

    act(() => {
      window.localStorage.setItem(RECENT_PLACES_KEY, JSON.stringify([place(8)]));
      window.dispatchEvent(new StorageEvent("storage", { key: RECENT_PLACES_KEY }));
    });

    expect(result.current.places).toEqual([place(8)]);
  });

  it("forgets everything on clear", () => {
    window.localStorage.setItem(RECENT_PLACES_KEY, JSON.stringify([place(1), place(2)]));
    const { result } = renderHook(() => useRecentPlaces());

    act(() => {
      result.current.clear();
    });

    expect(result.current.places).toEqual([]);
    expect(window.localStorage.getItem(RECENT_PLACES_KEY)).toBeNull();
  });

  it("stops listening when the field goes away", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useRecentPlaces());

    unmount();

    expect(remove).toHaveBeenCalledWith("storage", expect.any(Function));
  });

  it("keeps working when storage refuses to answer (a blocked or full store)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const { result } = renderHook(() => useRecentPlaces());

    act(() => {
      result.current.remember(place(1));
      result.current.clear();
    });

    expect(result.current.places).toEqual([]);
  });
});
