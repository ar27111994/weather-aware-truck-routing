import { useEffect, useState } from "react";

/** The longest wait the countdown shows, in seconds: one day. A server that asks for more gets this. */
const MAX_WAIT_SECONDS = 24 * 60 * 60;

/** Milliseconds in a second: the length of one tick, and the factor between seconds and the clock. */
const SECOND_MS = 1000;

/**
 * A `Retry-After` value as the whole seconds the panel waits and shows, from 0 to one day. Nothing
 * to wait for (`undefined`, NaN, zero, a negative number) is 0. A fraction rounds up, so a retry
 * never fires early. Infinity, and any number too big to read as a wait (the API parses a header of
 * a few hundred digits to Infinity), are capped at one day.
 *
 * @param seconds - The value as the API gives it.
 * @returns A whole number of seconds from 0 to 86,400.
 */
export function normalizeRetryAfter(seconds: number | undefined): number {
  if (seconds === undefined || Number.isNaN(seconds)) {
    return 0;
  }
  return Math.min(MAX_WAIT_SECONDS, Math.max(0, Math.ceil(seconds)));
}

interface Countdown {
  /** The normalized wait this countdown was started from. */
  readonly source: number;
  /** When the wait is over, on the clock of `Date.now()`. The seconds left are read off it. */
  readonly deadline: number;
  /** The whole seconds left at the last tick. */
  readonly remaining: number;
}

function startCountdown(waitSeconds: number): Countdown {
  return {
    source: waitSeconds,
    deadline: Date.now() + waitSeconds * SECOND_MS,
    remaining: waitSeconds,
  };
}

function secondsUntil(deadline: number): number {
  return Math.max(0, Math.ceil((deadline - Date.now()) / SECOND_MS));
}

/**
 * Counts a `Retry-After` value down to 0 and restarts when the value changes. It counts to a
 * deadline, not ticks: every tick reads the seconds left off the clock, so a tab in the background
 * (whose timers run late or not at all) shows the time that is really left at its next tick.
 * Pass the result to `ErrorState` as `retryAfterSeconds`: the retry button unlocks at 0.
 *
 * @param retryAfterSeconds - Seconds the server asked the client to wait; `undefined` for none.
 *   Normalized by {@link normalizeRetryAfter}, so NaN, a negative or a fractional number, and a
 *   huge one all give a countdown that can end.
 * @returns The seconds left; 0 when there is nothing to wait for.
 */
export function useRetryCountdown(retryAfterSeconds: number | undefined): number {
  const waitSeconds = normalizeRetryAfter(retryAfterSeconds);
  const [countdown, setCountdown] = useState(() => startCountdown(waitSeconds));

  // A new input starts a new countdown. Adjusting state while rendering (instead of in an effect)
  // means the first render with the new value already shows it, with no stale frame in between.
  // The input is compared after it is normalized: NaN is never equal to itself, a whole number is.
  let current = countdown;
  if (countdown.source !== waitSeconds) {
    current = startCountdown(waitSeconds);
    setCountdown(current);
  }

  const isCounting = current.remaining > 0;
  useEffect(() => {
    if (!isCounting) {
      return undefined;
    }
    const timer = setInterval(() => {
      setCountdown((previous) => ({ ...previous, remaining: secondsUntil(previous.deadline) }));
    }, SECOND_MS);
    return () => {
      clearInterval(timer);
    };
  }, [isCounting, current.source]);

  return current.remaining;
}
