import { act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { onTestFinished, vi } from "vitest";

/**
 * Installs Vitest fake timers in a way Testing Library can live with.
 *
 * `asyncWrapper` in React Testing Library (used by every `user-event` call) waits on a
 * `setTimeout(0)` and only advances it when it recognises Jest's fake timers by looking for a
 * global named `jest`. Vitest has no such global, so with a faked `setTimeout` the first
 * `await user.tab()` would hang until the test times out. Exposing the one method Testing Library
 * calls, wired to the Vitest clock, removes the hang without changing any assertion semantics. The
 * stub is removed after each test (`unstubGlobals` in the Vitest config); the caller restores real
 * timers with `vi.useRealTimers()`.
 */
export function installFakeTimers(): void {
  vi.useFakeTimers();
  vi.stubGlobal("jest", {
    advanceTimersByTime: (milliseconds: number): void => {
      vi.advanceTimersByTime(milliseconds);
    },
  });
}

/** A `user-event` instance whose waits run on the fake clock installed by {@link installFakeTimers}. */
export function fakeTimerUser(): UserEvent {
  return userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
}

/** Lets `ms` milliseconds pass on the fake clock, with React flushed in between. */
export async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** How many times {@link findUnderFakeTimers} runs its query before it gives up. */
export const FAKE_TIMER_POLLS = 100;

/** The time, in ms, that {@link findUnderFakeTimers} lets pass on the fake clock between two runs. */
export const FAKE_TIMER_POLL_MS = 50;

/**
 * Waits on the fake clock until `query` stops throwing, then returns what it returned. A test that
 * has called {@link installFakeTimers} waits with this, never with Testing Library's `findBy*` or
 * `waitFor`: those end only when a timeout timer fires on the clock that was current when they
 * began. A test that Vitest fails at its timeout leaves them running, `vi.useRealTimers()` and the
 * next test's `installFakeTimers()` replace that clock, and the timer can never fire any more. The
 * loop then polls for ever, never lets the event loop turn, and the worker never ends (R4F-VH).
 *
 * This wait counts its runs and never looks at a clock's timers, so it ends after `polls` runs at
 * the latest, wherever the clock has gone. Each pause lets a real turn of the event loop through.
 * It also ends with its test: a test that Vitest failed at its timeout does not leave a wait that
 * goes on running on the clock of the next test (the next test's own `act` calls then overlap it).
 *
 * `query` is synchronous and throws while it has nothing to return, as `screen.getByRole` does. The
 * first run is at once. Between two runs the clock moves {@link FAKE_TIMER_POLL_MS} ms with React
 * flushed, so a timer that the code under test has set can fire. After the last run the wait throws
 * the error of that run, so the failure says what was missing (Testing Library's message, with the
 * page in it).
 *
 * @throws RangeError when `polls` is not a whole number of at least 1.
 * @throws Error when it is called outside a test or a hook of one (`onTestFinished` needs a test).
 */
export async function findUnderFakeTimers<T>(
  query: () => T,
  { polls = FAKE_TIMER_POLLS }: { readonly polls?: number } = {},
): Promise<T> {
  if (!Number.isInteger(polls) || polls < 1) {
    throw new RangeError(`polls is a whole number of at least 1, not ${String(polls)}.`);
  }
  const testIsOver = new AbortController();
  onTestFinished(() => {
    testIsOver.abort();
  });
  let lastError: unknown;
  for (let run = 1; run <= polls; run += 1) {
    if (run > 1) {
      await elapse(FAKE_TIMER_POLL_MS);
      if (testIsOver.signal.aborted) break;
    }
    try {
      return query();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Hovers a trigger the way a real mouse does. React Aria only treats a hover as a pointer hover
 * once it has seen pointer activity on the page (`getInteractionModality() === "pointer"`), and
 * `user.hover` fires `pointerenter` before its first `pointermove`, so on a fresh page the very
 * first hover would be ignored. A person's mouse always moves over the page before it reaches a
 * button, so the helper does the same first.
 */
export async function hoverLikeAMouse(user: UserEvent, target: Element): Promise<void> {
  await user.pointer({ target: document.body });
  await user.hover(target);
}
