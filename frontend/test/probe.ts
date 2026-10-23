// THROWAWAY PROBE (INT-NEW-1), never merged: output for the failing PlannerPage progress test.
import { expect } from "vitest";

/** One probe line on stdout: the running test, the time, and what happened. */
export function probeLog(line: string): void {
  const name = expect.getState().currentTestName ?? "?";
  process.stdout.write(`[probe] ${name.slice(-48)} @${Math.round(performance.now())}ms ${line}\n`);
}

// Every abort() that comes through the plan mutation (useCreatePlan lives in app/api/queries).
const realAbort = AbortController.prototype.abort;
AbortController.prototype.abort = function abort(this: AbortController, reason?: unknown): void {
  const stack = new Error("trace").stack ?? "";
  if (stack.includes("app/api/queries")) {
    const frames = stack
      .split("\n")
      .slice(2, 9)
      .map((frame) => frame.trim().replace(/^at /u, ""))
      .join(" <- ");
    probeLog(`ABORT via ${frames}`);
  }
  realAbort.call(this, reason);
};

// A request timeout that fires: how long after it was made.
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms: number): AbortSignal => {
  const signal = realTimeout(ms);
  const made = performance.now();
  signal.addEventListener("abort", () => {
    probeLog(`AbortSignal.timeout(${String(ms)}) FIRED after ${Math.round(performance.now() - made)}ms`);
  });
  return signal;
};
