/** The side of an input that its list opens on. */
export type ListSide = "bottom" | "top";

/**
 * The room below an input, in px, that a list needs to open under it: about three of its two-line
 * rows. A list is five rows tall at most.
 */
export const MIN_ROOM_BELOW = 200;

/**
 * The side of `input` that its list opens on: below, unless there is less room below it than
 * {@link MIN_ROOM_BELOW} and more room above it. The room is measured in the part of the page that
 * can be seen, so an on-screen keyboard that covers the lower part counts.
 *
 * The input and the screen decide, and the size of the list must not. A list changes size while it
 * is open: a search that is still running shows one row, and the results are taller. React Aria
 * moves a list that no longer fits to the other side of the input, and it does so in the callback
 * of the ResizeObserver that watches the list. The list then grows within the frame that reported
 * its size, and the browser reports "ResizeObserver loop completed with undelivered
 * notifications" (R4-01, WebKit).
 *
 * That is an upstream workaround and UX choice (D-55): the list keeps one side of its input and
 * never changes side because its own size changed. The upstream bug is
 * https://github.com/adobe/react-spectrum/issues/7718. When a React Aria release closes #7718,
 * decide by design whether a list may change side while it is open. Until a ruling changes it,
 * the side stays.
 *
 * @param input - The input of the combo box, or `null` before it is on the page.
 */
export function listSideFor(input: Element | null): ListSide {
  if (input === null) return "bottom";
  const { top, bottom } = input.getBoundingClientRect();
  const viewport = window.visualViewport;
  const visibleTop = viewport?.offsetTop ?? 0;
  const visibleBottom = visibleTop + (viewport?.height ?? document.documentElement.clientHeight);
  const below = visibleBottom - bottom;
  const above = top - visibleTop;
  return below < MIN_ROOM_BELOW && above > below ? "top" : "bottom";
}
