import { vi } from "vitest";

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
