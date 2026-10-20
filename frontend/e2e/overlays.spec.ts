import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * The real tooltip overlays on the real page. Unit tests cannot cover how a tooltip leaves: jsdom
 * has no animations, and the exit of a tooltip waits for its animation to finish.
 */

/**
 * How long a closed tooltip may take to leave the page: twice the longest honest path (React Aria's
 * 500 ms close delay after a hover ends, plus the 200 ms exit animation). A tooltip that is stuck
 * never leaves, so the exact figure is not what the tests prove; it only has to be finite.
 */
const CLOSE_DELAY_MS = 500;
const EXIT_ANIMATION_MS = 200;
const EXIT_WITHIN_MS = 2 * (CLOSE_DELAY_MS + EXIT_ANIMATION_MS);

/**
 * Puts keyboard focus on the first theme radio in the header with real key presses, because React
 * Aria opens a tooltip on focus only for keyboard focus (a script's `focus()` is not).
 */
async function focusFirstThemeRadioWithKeyboard(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("link", { name: "Methodology" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "Light theme" })).toBeFocused();
  await expect(page.getByRole("tooltip")).toHaveText("Light theme");
}

test.describe("tooltip", () => {
  test("is removed from the page when keyboard focus leaves its trigger", async ({ page }) => {
    await focusFirstThemeRadioWithKeyboard(page);

    await page.keyboard.press("Shift+Tab");

    await expect(page.getByRole("link", { name: "Methodology" })).toBeFocused();
    // A closed tooltip that stays mounted at opacity 0 is still announced by screen readers.
    await expect(page.getByRole("tooltip")).toHaveCount(0, { timeout: EXIT_WITHIN_MS });
  });

  test("is removed from the page when focus moves on to the next trigger and then leaves", async ({
    page,
  }) => {
    await focusFirstThemeRadioWithKeyboard(page);

    // The arrow keys move focus along the theme toggle: the first tooltip closes because the next
    // one opens, and that is not the same exit as a blur.
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("radio", { name: "Dark theme" })).toBeFocused();
    await expect(page.getByRole("tooltip", { name: "Dark theme" })).toBeVisible();
    await page.keyboard.press("Shift+Tab");

    await expect(page.getByRole("link", { name: "Methodology" })).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveCount(0, { timeout: EXIT_WITHIN_MS });
  });

  test("is removed from the page when Escape closes it", async ({ page }) => {
    await focusFirstThemeRadioWithKeyboard(page);

    await page.keyboard.press("Escape");

    await expect(page.getByRole("tooltip")).toHaveCount(0, { timeout: EXIT_WITHIN_MS });
  });

  test("is removed from the page when the pointer leaves its trigger", async ({ page }) => {
    await page.goto("/");
    const canHover = await page.evaluate(() => window.matchMedia("(hover: hover)").matches);
    test.skip(!canHover, "this device has no hover");
    // React Aria opens a tooltip on hover once the page has seen a pointer press.
    await page.mouse.click(2, 300);
    await page.getByRole("radio", { name: "Dark theme" }).hover();
    await expect(page.getByRole("tooltip")).toHaveText("Dark theme");

    await page.mouse.move(640, 400);

    await expect(page.getByRole("tooltip")).toHaveCount(0, { timeout: EXIT_WITHIN_MS });
  });
});
