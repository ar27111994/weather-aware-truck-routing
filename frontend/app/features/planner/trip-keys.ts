/**
 * The query parameters of a trip link (R9), in the order `buildTripSearch` writes them. They live
 * apart from `trip-url.ts` so that the page's first code can ask whether an address carries a trip
 * without loading the schemas the parser needs (N1); `trip-url.test.ts` keeps the list in step with
 * what the parser reads and the builder writes.
 */
export const TRIP_KEYS = [
  "origin",
  "destination",
  "depart",
  "load",
  "interval",
  "scenario",
  "plan",
] as const;
