import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import fc from "fast-check";
import { afterEach } from "vitest";

import { installConsoleGuard } from "./test/console-guard";

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
