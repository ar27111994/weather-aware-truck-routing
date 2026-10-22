import { createIntentGate, type IntentGate } from "./intent";

/**
 * The gate of this page. It is made when the page's code first runs, so it hears the visitor from
 * the first moment on, and it is `null` where there is no browser (the prerender), which has no
 * visitor to wait for.
 */
export const pageGate: IntentGate | null =
  typeof document === "undefined" ? null : createIntentGate(document);
