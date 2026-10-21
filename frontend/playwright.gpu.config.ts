import { defineConfig, devices } from "@playwright/test";

import base from "./playwright.config";

// Tier 1 of the R7 budget (D-39), the budget of record: the R7 sweep alone, in Playwright's
// Chromium new headless (`channel: "chromium"`), which draws with the machine's GPU. The spec fails
// when the renderer is a software one, judges the page's raw numbers, and appends every run, pass or
// fail, to the log that PERF_GPU_LOG names. Run it on a machine with a GPU: `pnpm perf:r7:gpu`.
// Tier 2 is the same spec in every other project (CI included), see docs/CI-CD.md.
export default defineConfig({
  ...base,
  projects: [
    {
      name: "chromium-gpu",
      testMatch: /map\.spec\.ts$/,
      grep: /@perf/,
      metadata: { r7Tier: "gpu" },
      use: { ...devices["Desktop Chrome"], channel: "chromium" },
    },
  ],
});
