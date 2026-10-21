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

/** How long the pointer must rest on a trigger before its tooltip opens (`Tooltip`'s default delay). */
const OPEN_DELAY_MS = 400;

/**
 * Puts keyboard focus on the theme radio of the header with real key presses, because React Aria
 * opens a tooltip on focus only for keyboard focus (a script's `focus()` is not). A radio group is
 * one tab stop and it is the selected radio (D-26), so Tab from the link before it lands on the
 * default theme, "Match system theme".
 */
async function focusThemeRadioWithKeyboard(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("link", { name: "Methodology" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "Match system theme" })).toBeFocused();
  await expect(page.getByRole("tooltip")).toHaveText("Match system theme");
}

test.describe("tooltip", () => {
  test("is removed from the page when keyboard focus leaves its trigger", async ({ page }) => {
    await focusThemeRadioWithKeyboard(page);

    await page.keyboard.press("Shift+Tab");

    await expect(page.getByRole("link", { name: "Methodology" })).toBeFocused();
    // A closed tooltip that stays mounted at opacity 0 is still announced by screen readers.
    await expect(page.getByRole("tooltip")).toHaveCount(0, { timeout: EXIT_WITHIN_MS });
  });

  test("is removed from the page when focus moves on to the next trigger and then leaves", async ({
    page,
  }) => {
    await focusThemeRadioWithKeyboard(page);

    // The arrow keys move focus along the theme toggle: the first tooltip closes because the next
    // one opens, and that is not the same exit as a blur.
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("radio", { name: "Dark theme" })).toBeFocused();
    await expect(page.getByRole("tooltip", { name: "Dark theme" })).toBeVisible();
    await page.keyboard.press("Shift+Tab");

    await expect(page.getByRole("link", { name: "Methodology" })).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveCount(0, { timeout: EXIT_WITHIN_MS });
  });

  // A trigger below the fold: the Tab that reaches it also scrolls it into view, and the browser
  // sends the `scroll` event after the `focus` event that opened the tooltip. React Aria closes a
  // tooltip on scroll, so the tooltip used to be taken away 25 to 110 ms after it appeared, with
  // focus still on its trigger (measured in Chromium and Firefox on the unfixed component).
  test("stays open when the Tab that focuses its trigger scrolls it into view", async ({
    page,
  }) => {
    await page.goto("/design");
    await expect(page.getByRole("heading", { level: 1, name: "Design system" })).toBeVisible();
    const trigger = page
      .locator('[data-demo="Tooltip"] [data-state="closed"]')
      .getByRole("button", { name: "Swap" });
    // Focus the control before the trigger from the top of the page without scrolling, so that
    // the next Tab has to scroll.
    await page.evaluate(() => {
      const swap = document.querySelector('[data-demo="Tooltip"] [data-state="closed"] button');
      const tabbable = [
        ...document.querySelectorAll(
          "a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex='-1'])",
        ),
      ];
      window.scrollTo(0, 0);
      const swapIndex = swap === null ? -1 : tabbable.indexOf(swap);
      const previous = tabbable[swapIndex - 1];
      if (previous instanceof HTMLElement) {
        previous.focus({ preventScroll: true });
      }
    });
    const scrolled = page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          window.addEventListener("scroll", () => resolve(), { once: true });
        }),
    );

    await page.keyboard.press("Tab");
    await scrolled;

    // The unfixed tooltip closed within 113 ms of the scroll event (worst of four runs). Twelve
    // frames, 200 ms at 60 Hz and more on a slow machine, are rendering updates in which React
    // would have run that close.
    await page.evaluate(async () => {
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    });
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAccessibleDescription("Swap origin and destination");
    await expect(page.getByRole("tooltip")).toHaveText("Swap origin and destination");
  });

  test("is removed from the page when Escape closes it", async ({ page }) => {
    await focusThemeRadioWithKeyboard(page);

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

  // A disabled icon button never shows its tooltip, however long the pointer rests on it. jsdom
  // delivers no hover to a disabled button, so the unit test cannot tell; a real browser can. The
  // control first proves that this very hover opens the tooltip of an enabled one, so "no tooltip"
  // cannot mean "no hover". (Forcing the tooltip's own `isDisabled` to false changes nothing in
  // Chromium either: the browser sends a disabled button no hover, so `IconButton`'s pass-through
  // is redundant rather than untested.)
  test("never opens on a disabled icon button, however long the pointer rests on it", async ({
    page,
  }) => {
    await page.goto("/design");
    const canHover = await page.evaluate(() => window.matchMedia("(hover: hover)").matches);
    test.skip(!canHover, "this device has no hover");
    const iconButton = (state: string): ReturnType<Page["locator"]> =>
      page.locator(`section[data-demo="IconButton"] figure[data-state="${state}"] button`);
    // React Aria opens a tooltip on hover once the page has seen a pointer press.
    await page.mouse.click(2, 300);

    await iconButton("ghost").hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.mouse.move(2, 300);
    await expect(page.getByRole("tooltip")).toHaveCount(0, { timeout: EXIT_WITHIN_MS });

    await iconButton("disabled").hover();
    // Three times the delay: a tooltip that was going to open has opened by now.
    await page.waitForTimeout(3 * OPEN_DELAY_MS);

    await expect(page.getByRole("tooltip")).toHaveCount(0);
  });
});
