import { vi } from "vitest";

/** Handle returned by {@link installMatchMedia}. */
export interface MatchMediaController {
  /** Changes whether a media query matches and notifies every listener registered for it. */
  readonly setMatches: (query: string, matches: boolean) => void;
}

type ChangeListener = (event: MediaQueryListEvent) => void;

/**
 * jsdom does not implement `window.matchMedia`. This installs a controllable stand-in (removed
 * automatically after each test because the Vitest config sets `unstubGlobals`).
 *
 * @param initial - Media query strings mapped to whether they match; anything else does not.
 */
export function installMatchMedia(
  initial: Readonly<Record<string, boolean>> = {},
): MatchMediaController {
  const state = new Map<string, boolean>(Object.entries(initial));
  const listeners = new Map<string, Set<ChangeListener>>();

  const listenersFor = (query: string): Set<ChangeListener> => {
    const existing = listeners.get(query);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Set<ChangeListener>();
    listeners.set(query, created);
    return created;
  };

  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => {
    const list = {
      media: query,
      onchange: null,
      get matches(): boolean {
        return state.get(query) ?? false;
      },
      addEventListener: (type: string, listener: ChangeListener): void => {
        if (type === "change") {
          listenersFor(query).add(listener);
        }
      },
      removeEventListener: (type: string, listener: ChangeListener): void => {
        if (type === "change") {
          listenersFor(query).delete(listener);
        }
      },
      addListener: (listener: ChangeListener): void => {
        listenersFor(query).add(listener);
      },
      removeListener: (listener: ChangeListener): void => {
        listenersFor(query).delete(listener);
      },
      dispatchEvent: (): boolean => true,
    };
    return list as unknown as MediaQueryList;
  });

  return {
    setMatches(query, matches) {
      state.set(query, matches);
      for (const listener of listenersFor(query)) {
        listener({ matches, media: query } as MediaQueryListEvent);
      }
    },
  };
}
