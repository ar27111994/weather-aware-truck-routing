import type { Page } from "@playwright/test";

import { expect, test } from "./support/mock-api";
import { openPlanner, tripAddress } from "./support/planner";

type ThemeName = "light" | "dark";

const THEMES: readonly ThemeName[] = ["light", "dark"];
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
] as const;

// The language, the zone and (inside `openPlanner`) the clock are pinned: a golden of today's
// arrival times would be wrong tomorrow.
test.use({ locale: "en-US", timezoneId: "America/Denver" });

/** Saves the theme before the page loads, as a returning visitor would have it. */
async function saveTheme(page: Page, theme: ThemeName): Promise<void> {
  await page.addInitScript((saved) => {
    window.localStorage.setItem("hc-theme", saved);
  }, theme);
}

async function settle(page: Page, theme: ThemeName): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  // A golden of fallback fonts would be a golden of the wrong thing.
  await page.evaluate(() => document.fonts.ready);
  // A pointer left over a control would draw its hover state into the picture.
  await page.mouse.move(0, 0);
}

// Goldens are tagged `@golden`; only the `chromium` project runs them (playwright.config.ts), and
// only on Linux, the platform of CI, whose "Update visual goldens" workflow makes the baselines.
// On any other operating system a comparison could only be a false alarm.
test.describe("visual goldens: the planner and the methodology page", () => {
  test.skip(
    process.platform !== "linux",
    "goldens are made and enforced on Linux (CI); run the Update visual goldens workflow to refresh them",
  );
  // A golden that needs a second try to pass is a flaky golden, not a passing one.
  test.describe.configure({ retries: 0 });

  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test.describe(`${theme}, ${viewport.name} (${String(viewport.width)} px)`, () => {
        test.use({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: theme,
        });

        test(
          "the empty planner matches the visual golden",
          { tag: "@golden" },
          async ({ page }) => {
            await saveTheme(page, theme);
            await openPlanner(page);
            await settle(page, theme);

            await expect(page).toHaveScreenshot(`planner-empty-${theme}-${viewport.name}.png`, {
              animations: "disabled",
            });
          },
        );

        test(
          "a plan with simulated weather matches the visual golden",
          { tag: "@golden" },
          async ({ page, backend }) => {
            await saveTheme(page, theme);
            await openPlanner(page, tripAddress("mixed"));
            await page.getByRole("button", { name: "Plan routes" }).click();
            await expect(page.getByText(/^Take Route [A-C]\.$/u)).toBeVisible();
            // The corridor forecast has been asked for and answered before the picture is taken.
            await expect
              .poll(() => backend.requests.some((request) => request.includes("/heatmap")))
              .toBe(true);
            await settle(page, theme);

            await expect(page).toHaveScreenshot(`planner-plan-${theme}-${viewport.name}.png`, {
              animations: "disabled",
            });
          },
        );

        test(
          "the methodology page matches the visual golden",
          { tag: "@golden" },
          async ({ page }) => {
            await saveTheme(page, theme);
            await page.goto("/methodology");
            await expect(
              page.getByRole("heading", { level: 1, name: "How Haulcast scores weather risk" }),
            ).toBeVisible();
            await settle(page, theme);

            await expect(page).toHaveScreenshot(`methodology-${theme}-${viewport.name}.png`, {
              fullPage: true,
              animations: "disabled",
            });
          },
        );
      });
    }
  }
});
