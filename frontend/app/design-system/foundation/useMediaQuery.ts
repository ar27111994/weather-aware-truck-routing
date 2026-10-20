import { useMemo, useSyncExternalStore } from "react";

interface MediaQueryStore {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => boolean;
}

/**
 * The two functions `useSyncExternalStore` needs for one query. Both read the same
 * `MediaQueryList`, made on first use and never while rendering on the server, where there is no
 * `window`. React compares `subscribe` by identity, so a store that is rebuilt on every render
 * would unsubscribe and subscribe again each time (R1-40).
 */
function mediaQueryStore(query: string): MediaQueryStore {
  let list: MediaQueryList | undefined;
  const listOf = (): MediaQueryList => {
    list ??= window.matchMedia(query);
    return list;
  };
  return {
    subscribe(onChange) {
      const subscribed = listOf();
      subscribed.addEventListener("change", onChange);
      return () => {
        subscribed.removeEventListener("change", onChange);
      };
    },
    getSnapshot: () => listOf().matches,
  };
}

/** The server cannot know: report `false`, and so does the first client render. */
function getServerSnapshot(): boolean {
  return false;
}

/**
 * Whether a CSS media query currently matches, kept live. The server snapshot is `false`, and so is
 * the first client render during hydration, then it updates: no hydration mismatch.
 *
 * @param query - A media query such as `(prefers-color-scheme: dark)`.
 */
export function useMediaQuery(query: string): boolean {
  const { subscribe, getSnapshot } = useMemo(() => mediaQueryStore(query), [query]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
