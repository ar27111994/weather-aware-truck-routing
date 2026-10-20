import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * What the Vitest suites cannot see (R1-22): the real overlays opened with a real keyboard, motion
 * that is switched off, and the size of what a thumb has to hit. The kitchen sink's "open" tooltip
 * and popover are drawn in place so that the page can be photographed; the ones below are the
 * components' own, portalled, positioned and closed the way a visitor gets them.
 */

async function openDesign(page: Page): Promise<void> {
  await page.goto("/design");
  await expect(page.getByRole("heading", { level: 1, name: "Design system" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

function specimen(page: Page, demo: string, state: string): Locator {
  return page.locator(`[data-demo="${demo}"] [data-state="${state}"]`);
}

/** The label that draws a radio (React Aria puts the radio's states and size on the label). */
function labelOf(radio: Locator): Locator {
  return radio.locator("xpath=ancestor::label");
}

/**
 * Puts keyboard focus on `target` the way a keyboard user gets there: by Tab. React Aria opens a
 * tooltip and shows a focus ring only for keyboard focus, and a script's `focus()` is not that.
 */
async function focusWithKeyboard(page: Page, target: Locator): Promise<void> {
  await target.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();

  expect(
    results.violations.map(
      (violation) =>
        `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(" | ")}`,
    ),
  ).toEqual([]);
}

test.describe("the real overlays", () => {
  test("a tooltip opened with the keyboard names its trigger and has no axe violations", async ({
    page,
  }) => {
    await openDesign(page);
    const trigger = specimen(page, "Tooltip", "closed").getByRole("button", { name: "Swap" });

    await focusWithKeyboard(page, trigger);

    await expect(page.getByRole("tooltip")).toHaveText("Swap origin and destination");
    await expect(trigger).toHaveAccessibleDescription("Swap origin and destination");
    await expectNoAxeViolations(page);
  });

  test("a popover opened with the keyboard takes focus, has no axe violations, and gives focus back on Escape", async ({
    page,
  }) => {
    await openDesign(page);
    const trigger = specimen(page, "Popover", "closed").getByRole("button", { name: "Legend" });
    await focusWithKeyboard(page, trigger);

    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Legend" });
    await expect(dialog).toContainText("Checkpoint 7");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    await expectNoAxeViolations(page);

    await page.keyboard.press("Escape");

    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});

test.describe("reduced motion (DESIGN.md 6)", () => {
  /** The animation each moving thing runs, as the browser computes it. */
  async function animations(page: Page): Promise<Record<string, string>> {
    return page.evaluate(() => {
      const nameOf = (selector: string): string => {
        const element = document.querySelector(selector);
        return element === null ? "missing" : getComputedStyle(element).animationName;
      };
      return {
        spinner: nameOf("[data-demo='Spinner'] svg"),
        skeleton: nameOf("[data-demo='Skeleton'] [data-height]"),
      };
    });
  }

  test("the spinner and the skeleton are in motion when motion is not reduced", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await openDesign(page);

    const running = await animations(page);

    expect(running["spinner"]).not.toMatch(/^(none|missing)$/);
    expect(running["skeleton"]).not.toMatch(/^(none|missing)$/);
  });

  test.describe("when the visitor asks for less", () => {
    test.use({ reducedMotion: "reduce" });

    test("the spinner is still and the skeleton holds one static level", async ({ page }) => {
      await openDesign(page);

      expect(await animations(page)).toEqual({ spinner: "none", skeleton: "none" });
      const opacity = await page
        .locator("[data-demo='Skeleton'] [data-height]")
        .first()
        .evaluate((node) => getComputedStyle(node).opacity);
      expect(opacity).toBe("0.75");
    });

    test("every animation duration is zero, but the playback cadence and the hover delay stay", async ({
      page,
    }) => {
      await openDesign(page);

      const durations = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        return Object.fromEntries(
          [
            "fast",
            "base",
            "slow",
            "sheet",
            "camera",
            "skeleton",
            "spinner",
            "frame",
            "tooltip-delay",
          ].map((name) => [name, root.getPropertyValue(`--motion-duration-${name}`).trim()]),
        );
      });

      expect(durations).toEqual({
        fast: "0ms",
        base: "0ms",
        slow: "0ms",
        sheet: "0ms",
        camera: "0ms",
        skeleton: "0ms",
        spinner: "0ms",
        // Intervals, not animations (R1-16): zeroing them would make Play step through all 48
        // hours back to back, and make a tooltip open before the pointer has rested.
        frame: "250ms",
        "tooltip-delay": "400ms",
      });
    });
  });
});

interface Target {
  readonly name: string;
  readonly locate: (page: Page) => Locator;
}

const TARGETS: readonly Target[] = [
  {
    name: "a Button",
    locate: (page) =>
      specimen(page, "Button", "primary").getByRole("button", { name: "Plan routes" }),
  },
  {
    name: "an IconButton",
    locate: (page) =>
      specimen(page, "IconButton", "ghost").getByRole("button", { name: "Copy link" }),
  },
  {
    name: "a Chip",
    locate: (page) => specimen(page, "Chip", "unselected").getByRole("button", { name: "Wind" }),
  },
  {
    name: "a Segmented item",
    locate: (page) =>
      labelOf(specimen(page, "Segmented", "interval").getByRole("radio", { name: "10 mi" })),
  },
  {
    name: "a ThemeToggle item",
    locate: (page) =>
      labelOf(specimen(page, "ThemeToggle", "system").getByRole("radio", { name: "Light theme" })),
  },
  { name: "a Switch", locate: (page) => page.locator("[data-demo='Switch'] label").first() },
];

/**
 * DESIGN.md 8.2 and WCAG 2.5.8: a target is at least 24 CSS px in both directions on any screen,
 * and at least 44 px (`--size-target-touch`) on a screen narrower than 1024 px, where a thumb is
 * the pointer. The hidden native input of a radio or a switch is not the target: its label is.
 */
const SCREENS = [
  { name: "phone", width: 390, height: 844, minimum: 44 },
  { name: "desktop", width: 1280, height: 800, minimum: 24 },
] as const;

for (const screen of SCREENS) {
  test.describe(`touch targets on a ${screen.name} (${String(screen.width)} px wide)`, () => {
    test.use({ viewport: { width: screen.width, height: screen.height } });

    for (const target of TARGETS) {
      test(`${target.name} is at least ${String(screen.minimum)} px high and wide`, async ({
        page,
      }) => {
        await openDesign(page);
        const element = target.locate(page);
        await element.scrollIntoViewIfNeeded();

        const box = await element.boundingBox();

        if (box === null) {
          throw new Error(`${target.name} has no box on /design`);
        }
        expect(box.height).toBeGreaterThanOrEqual(screen.minimum);
        expect(box.width).toBeGreaterThanOrEqual(screen.minimum);
      });
    }
  });
}
