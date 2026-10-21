import { useEffect, useState } from "react";

/** The delay before a query is sent: R1 asks for at least 250 ms. */
export const SEARCH_DEBOUNCE_MS = 250;

/**
 * The value, once it has stopped changing for `delayMs`. The first value is returned at once; each
 * later change restarts the wait, so a burst of keystrokes sends one request.
 */
export function useDebouncedValue<T>(value: T, delayMs: number = SEARCH_DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);
  return settled;
}
