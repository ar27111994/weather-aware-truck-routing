import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/**
 * Tells whether the browser is in the middle of dispatching a `scroll` event, for as long as that
 * dispatch lasts.
 *
 * React Aria closes an open tooltip or combo box list from a `scroll` listener that it adds to the
 * window, in the capture phase, when the overlay opens. Listeners on one target run in the order
 * they were added, so the one added here, when the component mounts, runs first and raises the
 * flag before React Aria's runs. The flag comes down in the next animation frame callback, and the
 * browser dispatches a scroll event as one of the steps of a rendering update, before that
 * update's animation frame callbacks, so nothing else (a key press, a click) can happen in
 * between.
 *
 * @returns A ref that holds `true` while a `scroll` event is being dispatched.
 */
export function useScrollDispatch(): RefObject<boolean> {
  const dispatching = useRef(false);
  useEffect(() => {
    const lower = (): void => {
      dispatching.current = false;
    };
    const raise = (): void => {
      dispatching.current = true;
      requestAnimationFrame(lower);
    };
    window.addEventListener("scroll", raise, { capture: true, passive: true });
    return () => {
      window.removeEventListener("scroll", raise, { capture: true });
    };
  }, []);
  return dispatching;
}
