import { useCallback, useMemo, useSyncExternalStore } from "react";

import { planLocationSchema, type PlanLocation } from "../../api/contract";

/** localStorage key of the recent searches (DESIGN.md section 10). */
export const RECENT_PLACES_KEY = "hc-recent-places";
/** How many places are kept (R1). */
export const RECENT_PLACES_LIMIT = 8;

function sameKey(place: PlanLocation): string {
  return `${place.label}|${String(place.lat)}|${String(place.lon)}`;
}

/**
 * Reads the stored list: any entry that is not a valid place is dropped, repeats are dropped, and
 * the list is cut to the limit. Whatever a stale, edited or foreign value holds, the result is a
 * list of valid places.
 */
export function parseRecentPlaces(raw: string | null): readonly PlanLocation[] {
  if (raw === null) return [];
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  const places: PlanLocation[] = [];
  for (const entry of stored as unknown[]) {
    const place = planLocationSchema.safeParse(entry);
    if (place.success && !seen.has(sameKey(place.data))) {
      seen.add(sameKey(place.data));
      places.push(place.data);
    }
  }
  return places.slice(0, RECENT_PLACES_LIMIT);
}

/** `place` first, then the places that were there, without a repeat, cut to the limit. */
export function withRecentPlace(
  places: readonly PlanLocation[],
  place: PlanLocation,
): readonly PlanLocation[] {
  const chosen = planLocationSchema.parse(place);
  return [chosen, ...places.filter((known) => sameKey(known) !== sameKey(chosen))].slice(
    0,
    RECENT_PLACES_LIMIT,
  );
}

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Storage can be missing or refuse to answer (private modes, blocked cookies): no list then. */
function readRaw(): string | null {
  try {
    return window.localStorage.getItem(RECENT_PLACES_KEY);
  } catch {
    return null;
  }
}

function write(places: readonly PlanLocation[] | null): void {
  try {
    if (places === null) {
      window.localStorage.removeItem(RECENT_PLACES_KEY);
    } else {
      window.localStorage.setItem(RECENT_PLACES_KEY, JSON.stringify(places));
    }
  } catch {
    // The list is a convenience; a full or blocked storage must never break the planner.
  }
  for (const listener of listeners) listener();
}

/** What a prerendered page shows: no places (storage belongs to the browser). */
function readNothing(): string | null {
  return null;
}

export interface RecentPlaces {
  /** The saved places, newest first. */
  readonly places: readonly PlanLocation[];
  /** Saves a place the user chose, newest first. */
  readonly remember: (place: PlanLocation) => void;
  /** Forgets every saved place. */
  readonly clear: () => void;
}

/**
 * The places the user searched for before, kept in localStorage (R1) and shared across every
 * field and tab: a change in one is seen by the others. The prerendered page and the first client
 * render show none, so hydration matches.
 */
export function useRecentPlaces(): RecentPlaces {
  const raw = useSyncExternalStore(subscribe, readRaw, readNothing);
  const places = useMemo(() => parseRecentPlaces(raw), [raw]);
  const remember = useCallback((place: PlanLocation) => {
    write(withRecentPlace(parseRecentPlaces(readRaw()), place));
  }, []);
  const clear = useCallback(() => {
    write(null);
  }, []);
  return { places, remember, clear };
}
