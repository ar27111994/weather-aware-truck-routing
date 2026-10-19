import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const IN_CI = Boolean(process.env["CI"]);

// End-to-end suite skeleton. It runs against the production build served by `pnpm preview`; the
// real scenarios (recorded provider fixtures, axe checks, visual goldens) arrive with the e2e card.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: IN_CI,
  retries: IN_CI ? 2 : 0,
  reporter: IN_CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "pixel-7", use: { ...devices["Pixel 7"] } },
    { name: "iphone-14", use: { ...devices["iPhone 14"] } },
  ],
  webServer: {
    command: "pnpm build && pnpm preview",
    url: `http://127.0.0.1:${String(PORT)}`,
    reuseExistingServer: !IN_CI,
    timeout: 180_000,
  },
});
