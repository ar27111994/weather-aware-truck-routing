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
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "pixel-7", use: { ...devices["Pixel 7"] } },
    { name: "iphone-14", use: { ...devices["iPhone 14"] } },
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
