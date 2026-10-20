import { useEffect, useState } from "react";

interface Countdown {
  /** The `retryAfterSeconds` this countdown was started from. */
  readonly source: number | undefined;
  readonly remaining: number;
}

function startCountdown(retryAfterSeconds: number | undefined): Countdown {
  return { source: retryAfterSeconds, remaining: retryAfterSeconds ?? 0 };
}

/**
 * Counts a `Retry-After` value down to 0, once per second, and restarts when the value changes.
 * Pass the result to `ErrorState` as `retryAfterSeconds`: the retry button unlocks at 0.
 *
 * @param retryAfterSeconds - Seconds the server asked the client to wait; `undefined` for none.
 * @returns The seconds left; 0 when there is nothing to wait for.
 */
export function useRetryCountdown(retryAfterSeconds: number | undefined): number {
  const [countdown, setCountdown] = useState(() => startCountdown(retryAfterSeconds));

  // A new input starts a new countdown. Adjusting state while rendering (instead of in an effect)
  // means the first render with the new value already shows it, with no stale frame in between.
  let current = countdown;
  if (countdown.source !== retryAfterSeconds) {
    current = startCountdown(retryAfterSeconds);
    setCountdown(current);
  }

  const isCounting = current.remaining > 0;
  useEffect(() => {
    if (!isCounting) {
      return undefined;
    }
    const timer = setInterval(() => {
      setCountdown((previous) => ({ ...previous, remaining: Math.max(0, previous.remaining - 1) }));
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [isCounting, current.source]);

  return current.remaining;
}
