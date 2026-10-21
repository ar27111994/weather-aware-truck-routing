import { defineConfig, devices } from "@playwright/test";

// Port allocation: parallel workers share one machine, so every card owns a distinct port (see
// PROJECT.md section 9). T6a owns 4201. A taken port must fail loudly, never reuse a stranger's
// server (`reuseExistingServer: false`), because that would produce screenshots of the wrong app.
const PORT = Number(process.env["E2E_PORT"] ?? 4201);
const IN_CI = Boolean(process.env["CI"]);
// Set to test an already deployed site (the post-deploy smoke run); no local server is started.
const DEPLOYED_URL = process.env["E2E_BASE_URL"];

// End-to-end suite. It runs against the production build served by `pnpm preview`; the planner
// scenarios (recorded provider fixtures) arrive with the e2e card. The design-system suite lives in
// `e2e/design-system.spec.ts` and exercises the `/design` kitchen sink.
//
// `e2e/csp.spec.ts` is the exception: it needs the Vercel build output served with its security
// headers, which `pnpm preview` does not send. Only `scripts/e2e-csp.sh` (after
// `scripts/vercel-build.sh`) runs it, through the `csp-*` projects that `E2E_CSP=1` adds.
const CSP_SPEC = /csp\.spec\.ts$/;
const CSP_RUN = process.env["E2E_CSP"] === "1";

// Visual goldens (tests tagged `@golden`) run in the `chromium` project only: one engine on one
// platform (Linux, in CI) owns the baselines, so there is one set to keep, and a rendering
// difference between engines is never mistaken for a regression. The other projects leave them
// out; they are not skipped (R1-18). The R7 smoothness sweep (`@perf`) is measured the same way:
// its budget is set for Chromium on the CI machine (REQUIREMENTS.md R7).
const CHROMIUM_ONLY = /@golden|@perf/;

// Headless Firefox on the Linux CI runner has no GPU and no display, its graphics probe fails, and
// the blocklist then refuses WebGL 2 ("AllowWebgl2:false restricts context creation on this
// system"), which MapLibre needs. `webgl.force-enabled` alone lifts the WebGL 1 check only;
// `gfx.blocklist.all: -1` reports every graphics feature as allowed, so WebGL 2 renders in software,
// as Chromium does with SwiftShader. A user's Firefox has a GPU and its own blocklist.
const FIREFOX = {
  ...devices["Desktop Firefox"],
  launchOptions: {
    firefoxUserPrefs: { "webgl.force-enabled": true, "gfx.blocklist.all": -1 },
  },
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: IN_CI,
  retries: IN_CI ? 2 : 0,
  reporter: IN_CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: DEPLOYED_URL ?? `http://127.0.0.1:${String(PORT)}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", testIgnore: CSP_SPEC, use: { ...devices["Desktop Chrome"] } },
    {
      name: "firefox",
      testIgnore: CSP_SPEC,
      grepInvert: CHROMIUM_ONLY,
      use: FIREFOX,
    },
    {
      name: "webkit",
      testIgnore: CSP_SPEC,
      grepInvert: CHROMIUM_ONLY,
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "pixel-7",
      testIgnore: CSP_SPEC,
      grepInvert: CHROMIUM_ONLY,
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "iphone-14",
      testIgnore: CSP_SPEC,
      grepInvert: CHROMIUM_ONLY,
      use: { ...devices["iPhone 14"] },
    },
    ...(CSP_RUN
      ? [
          { name: "csp-chromium", testMatch: CSP_SPEC, use: { ...devices["Desktop Chrome"] } },
          { name: "csp-firefox", testMatch: CSP_SPEC, use: FIREFOX },
          { name: "csp-webkit", testMatch: CSP_SPEC, use: { ...devices["Desktop Safari"] } },
        ]
      : []),
  ],
  ...(DEPLOYED_URL === undefined
    ? {
        webServer: {
          command: "pnpm build && pnpm preview",
          url: `http://127.0.0.1:${String(PORT)}`,
          env: { E2E_PORT: String(PORT) },
          reuseExistingServer: false,
          timeout: 180_000,
        },
      }
    : {}),
});
