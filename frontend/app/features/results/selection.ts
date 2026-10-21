import type { Selection } from "react-aria-components";

/**
 * The route a single-selection list reports, as an id, or `null` for none. React Aria types a
 * selection as either a set of keys or the word `all`; a list in single-selection mode never
 * reports `all`, and it is read as no route so a stray value can never pick one that does not exist.
 */
export function selectedRouteId(selection: Selection): string | null {
  if (selection === "all") return null;
  const [first] = selection;
  return first === undefined ? null : String(first);
}
