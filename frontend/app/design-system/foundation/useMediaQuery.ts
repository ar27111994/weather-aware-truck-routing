import { useSyncExternalStore } from "react";

/**
 * Whether a CSS media query currently matches, kept live. The server snapshot is `false`, and so is
 * the first client render during hydration, then it updates: no hydration mismatch.
 *
 * @param query - A media query such as `(prefers-color-scheme: dark)`.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => {
        list.removeEventListener("change", onChange);
      };
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
