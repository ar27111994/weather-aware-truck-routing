import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, beforeEach, expect } from "vitest";

import { installConsoleGuard } from "./test/console-guard";
import "./test/probe";

beforeEach(() => {
  Reflect.set(globalThis, "__probeTest", expect.getState().currentTestName);
});

// A `waitFor` or `findBy*` that never succeeds still fails; the longer window only stops a loaded
// machine (parallel workers, coverage instrumentation) from timing out before React has settled.
configure({ asyncUtilTimeout: 5_000 });

// A failing property test prints its seed. `FC_SEED=<seed> pnpm test` replays that run exactly.
const replaySeed = process.env["FC_SEED"];
if (replaySeed !== undefined) {
  fc.configureGlobal({ seed: Number(replaySeed) });
}

installConsoleGuard();

// Testing Library only auto-cleans when test globals are enabled; we keep globals off.
afterEach(() => {
  cleanup();
});

// jsdom draws nothing and scrolls nothing, so it has no `scrollIntoView`. The planner asks for its
// panel to be scrolled into view when a plan arrives; a test that wants to see the request spies on
// this.
if (typeof Element !== "undefined") {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: (): void => undefined,
  });
}
