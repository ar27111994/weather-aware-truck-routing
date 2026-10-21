import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { openDesign } from "./support/design";

/**
 * The radio-group keyboard contract (D-26) in the real engines. `Segmented` and `ThemeToggle` are
 * radio groups, so they follow the ARIA Authoring Practices pattern: ONE tab stop, which is the
 * selected radio; the arrow keys move focus AND select, wrapping at both ends; a disabled radio is
 * skipped. The jsdom suites (`Segmented.test.tsx`, `ThemeToggle.test.tsx`) pin the same contract
 * against React Aria; here the engines' own focus handling gets to disagree, which is why it runs
 * in all of them. The previous toolbar-like behaviour (Tab landed on the first radio, arrows moved
 * focus only) fails every test in this file.
 */

/** The `Segmented` section of `/design`, the only section these tests load (D-35). */
const SEGMENTED = ["Segmented"];

/** One specimen (a demo section's state) on `/design`. */
function specimen(page: Page, demo: string, state: string): Locator {
  return page.locator(`[data-demo="${demo}"] [data-state="${state}"]`);
}

/** Puts focus on the group's tab stop the way a keyboard user gets there, coming from before it. */
async function tabInto(page: Page, group: Locator, stop: Locator): Promise<void> {
  await stop.focus();
  await page.keyboard.press("Shift+Tab");
  // One tab stop: Shift+Tab left the group instead of moving to its first radio.
  await expect(group.getByRole("radio").and(page.locator(":focus"))).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(stop).toBeFocused();
}

test.describe("Segmented", () => {
  test("is one tab stop, and the stop is the selected item", async ({ page }) => {
    await openDesign(page, { sections: SEGMENTED });
    const group = specimen(page, "Segmented", "interval");
    const selected = group.getByRole("radio", { name: "25 mi" });
    await expect(selected).toBeChecked();

    await tabInto(page, group, selected);
    await page.keyboard.press("Tab");

    await expect(group.getByRole("radio").and(page.locator(":focus"))).toHaveCount(0);
  });

  test("moves focus and selection together with the arrow keys, and wraps", async ({ page }) => {
    await openDesign(page, { sections: SEGMENTED });
    const group = specimen(page, "Segmented", "interval");
    await tabInto(page, group, group.getByRole("radio", { name: "25 mi" }));

    await page.keyboard.press("ArrowRight");
    await expect(group.getByRole("radio", { name: "50 mi" })).toBeFocused();
    await expect(group.getByRole("radio", { name: "50 mi" })).toBeChecked();
    await expect(group.getByRole("radio", { name: "25 mi" })).not.toBeChecked();

    await page.keyboard.press("ArrowRight");
    await expect(group.getByRole("radio", { name: "10 mi" })).toBeFocused();
    await expect(group.getByRole("radio", { name: "10 mi" })).toBeChecked();

    await page.keyboard.press("ArrowLeft");
    await expect(group.getByRole("radio", { name: "50 mi" })).toBeFocused();
    await expect(group.getByRole("radio", { name: "50 mi" })).toBeChecked();
  });

  test("skips a disabled item", async ({ page }) => {
    await openDesign(page, { sections: SEGMENTED });
    const group = specimen(page, "Segmented", "disabled-item");
    await expect(group.getByRole("radio", { name: "Rain" })).toBeDisabled();
    await tabInto(page, group, group.getByRole("radio", { name: "Risk" }));

    await page.keyboard.press("ArrowRight");
    await expect(group.getByRole("radio", { name: "Wind" })).toBeChecked();

    await page.keyboard.press("ArrowRight");
    await expect(group.getByRole("radio", { name: "Risk" })).toBeChecked();
    await expect(group.getByRole("radio", { name: "Rain" })).not.toBeChecked();
  });

  test("selects by click and keeps exactly one item selected", async ({ page }) => {
    await openDesign(page, { sections: SEGMENTED });
    const group = specimen(page, "Segmented", "interval");

    await group.getByText("10 mi").click();
    await group.getByText("10 mi").click();

    await expect(group.getByRole("radio", { name: "10 mi" })).toBeChecked();
    await expect(group.getByRole("radio", { checked: true })).toHaveCount(1);
  });
});

test.describe("ThemeToggle in the header", () => {
  test("is one tab stop, and the stop is the selected theme", async ({ page }) => {
    await page.goto("/");
    const toggle = page.getByRole("radiogroup", { name: "Theme" });
    const selected = toggle.getByRole("radio", { name: "Match system theme" });
    await expect(selected).toBeChecked();

    await tabInto(page, toggle, selected);
    await page.keyboard.press("Tab");

    await expect(toggle.getByRole("radio").and(page.locator(":focus"))).toHaveCount(0);
  });

  test("moves focus and selection together with the arrow keys, and applies the theme", async ({
    page,
  }) => {
    await page.goto("/");
    const toggle = page.getByRole("radiogroup", { name: "Theme" });
    await tabInto(page, toggle, toggle.getByRole("radio", { name: "Match system theme" }));

    await page.keyboard.press("ArrowLeft");
    await expect(toggle.getByRole("radio", { name: "Dark theme" })).toBeFocused();
    await expect(toggle.getByRole("radio", { name: "Dark theme" })).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.keyboard.press("ArrowLeft");
    await expect(toggle.getByRole("radio", { name: "Light theme" })).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // Wraps from the first radio to the last.
    await page.keyboard.press("ArrowLeft");
    await expect(toggle.getByRole("radio", { name: "Match system theme" })).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
  });
});
