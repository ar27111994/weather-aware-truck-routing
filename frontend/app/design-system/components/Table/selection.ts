import type { Key, Selection } from "react-aria-components";

/**
 * The one selected key of a React Aria selection, as a string; `null` when nothing is selected.
 * A single-selection table never reports `"all"`, but the type allows it, so it reads as empty.
 */
export function selectionToKey(selection: Selection): string | null {
  if (selection === "all") {
    return null;
  }
  const [first] = selection;
  return first === undefined ? null : String(first);
}

/**
 * The React Aria selection for a controlled `selectedKey`. `undefined` stays `undefined`, which
 * leaves React Aria in charge of the selection (uncontrolled); `null` is an empty selection.
 */
export function keyToSelection(key: string | null | undefined): Set<Key> | undefined {
  if (key === undefined) {
    return undefined;
  }
  return key === null ? new Set<Key>() : new Set<Key>([key]);
}
