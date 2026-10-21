import { useSyncExternalStore } from "react";

const noSubscription = (): (() => void) => () => undefined;

/**
 * `false` on the server and during the first client render (so hydration matches the prerendered
 * markup), `true` for every render after that. Anything that depends on the visitor's clock, time
 * zone or storage waits for it, so a build-time value never reaches the page.
 */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
}
