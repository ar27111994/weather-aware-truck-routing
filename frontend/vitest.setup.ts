import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// A `waitFor` or `findBy*` that never succeeds still fails; the longer window only stops a loaded
// machine (parallel workers, coverage instrumentation) from timing out before React has settled.
configure({ asyncUtilTimeout: 5_000 });

// Testing Library only auto-cleans when test globals are enabled; we keep globals off.
afterEach(() => {
  cleanup();
});
