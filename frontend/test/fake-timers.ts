import { act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
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
