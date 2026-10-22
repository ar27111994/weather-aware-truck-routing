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
// its budget is set for Chromium on the CI machine (REQUIREMENTS.md R7). So is the N1 size budget
// (`@budget`): the bytes served are the same for every engine, so one engine measures them.
const CHROMIUM_ONLY = /@golden|@perf|@budget/;

// Firefox runs its graphics probe (glxtest) at every startup, headless or not, and the probe needs
// an X11 or Wayland display (nsAppRunner.cpp; widget/gtk/GfxInfo.cpp). On the GPU-less Linux CI
// runner there is none, the probe fails, and a failed probe blocks WebGL 2
// (FEATURE_FAILURE_GLXTEST_FAILED; gfxPlatform sets AllowWebgl2 from the FEATURE_WEBGL2 status,
// which no pref changes: the WebGL force-enable pref is not an input to it, and the blocklist
// override pref is compiled out of release builds). MapLibre needs WebGL 2. So on CI only, the `firefox` and
// `csp-firefox` projects run headed inside Xvfb (D-40): the probe finds a display and Mesa's
// llvmpipe renders WebGL 2 in software. The explicit opt-in `E2E_FIREFOX_XVFB=1` turns headed mode
// on, and it is refused anywhere but under xvfb-run on the CI runner, so no window ever opens on a
// developer's desktop. Every other browser stays headless everywhere.
const FIREFOX_XVFB = process.env["E2E_FIREFOX_XVFB"] === "1";
if (FIREFOX_XVFB && (!IN_CI || process.platform !== "linux" || !process.env["DISPLAY"])) {
  throw new Error(
    "E2E_FIREFOX_XVFB=1 runs Firefox headed and is allowed only on the Linux CI runner under " +
      "xvfb-run (D-40): it needs CI set, Linux and a DISPLAY. Unset it to run every browser headless.",
  );
}
const FIREFOX = {
  ...devices["Desktop Firefox"],
  ...(FIREFOX_XVFB ? { headless: false } : {}),
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
