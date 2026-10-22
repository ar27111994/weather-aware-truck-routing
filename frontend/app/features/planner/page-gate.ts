import { createIntentGate, ISLAND_SELECTOR, type IntentGate, type LoadContext } from "./intent";

/**
 * The gate of this page. It is made when the page's code first runs, so it hears the visitor from
 * the first moment on, and it is `null` where there is no browser (the prerender), which has no
 * visitor to wait for.
 */
export const pageGate: IntentGate | null =
  typeof document === "undefined" ? null : createIntentGate(document);

/** What the loader of the planner's code needs to know about the page it is running on. */
export function pageContext(): LoadContext {
  return typeof document === "undefined"
    ? { gate: null, island: false, search: "" }
    : {
        gate: pageGate,
        island: document.querySelector(ISLAND_SELECTOR) !== null,
        search: window.location.search,
      };
}
