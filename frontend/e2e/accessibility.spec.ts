import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { PAGE_ONLY_SECTION, openDesign, settleAnimations } from "./support/design";

/**
 * What the Vitest suites cannot see (R1-22): the real overlays opened with a real keyboard, motion
 * that is switched off, and the size of what a thumb has to hit. The kitchen sink's "open" tooltip
 * and popover are drawn in place so that the page can be photographed; the ones below are the
 * components' own, portalled, positioned and closed the way a visitor gets them. Each test loads
 * the sections it uses and no others (D-35).
 */

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

/** What `expectNoAxeViolations` is asked to scan for. */
interface AxeScan {
  /** Whether axe's page-level `region` rule runs. */
  readonly regions: boolean;
  /**
   * Violations that are known and not fixed yet, by rule id, with the number of nodes that carry
   * each. The scan finds exactly these and no others: a violation that is not listed fails the
   * test, and so does a listed one that has gone, so a list cannot outlive its finding.
   */
  readonly known?: Readonly<Record<string, number>>;
}

/**
 * Runs every axe rule, on the page at rest (`settleAnimations`: a scan of an overlay that is still
 * entering depends on the browser's frame clock, not on the overlay). React Aria portals an overlay
 * to the end of `<body>`, outside the page's landmarks by design (the replicas drawn in place on
 * the page are not), and axe's page-level `region` rule reports the portal's container for it. The
 * overlay tests turn that one rule off with `regions: false` and keep every other rule, on the
 * overlay as well.
 */
async function expectNoAxeViolations(
  page: Page,
  { regions, known = {} }: AxeScan = { regions: true },
): Promise<void> {
  await settleAnimations(page);
  const results = await new AxeBuilder({ page }).disableRules(regions ? [] : ["region"]).analyze();
  const isKnown = (id: string): boolean => id in known;

  expect(
    results.violations
      .filter((violation) => !isKnown(violation.id))
      .map(
        (violation) =>
          `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(" | ")}`,
      ),
  ).toEqual([]);
  expect(
    Object.fromEntries(
      results.violations
        .filter((violation) => isKnown(violation.id))
        .map((violation) => [violation.id, violation.nodes.length]),
    ),
    "the known violations are exactly as they were: drop the ones that are fixed, and list a new one with its count",
  ).toEqual(known);
}

/*
 * FINDING OV-1 (found by these tests, not fixed by them). An option that shows a second line (a
 * Select item with a description, a ComboBox place with its region and kind) is named by its
 * title alone: React Aria points `aria-labelledby` at the title and `aria-describedby` at the
 * rest. Axe compares that name with all the text that the option shows, and reports
 * `label-content-name-mismatch` (WCAG 2.5.3, level A, serious) on every such option. No scan had
 * a list open before, and the fix is in the components (`SelectItem`, `ComboBoxItem`), which this
 * card does not change. Until then the two list scans expect the finding exactly as it is: every
 * other rule must pass on the list as on the rest of the page, a new violation fails, and so does
 * a fixed one, which is the signal to delete this constant and its two uses.
 */
const OPTIONS_WITH_A_DESCRIPTION = { "label-content-name-mismatch": 2 } as const;

/** How long an overlay may take to leave the page once it has been closed (R3-05). */
const LEAVES_WITHIN_MS = 1000;

/**
 * One titled state of a demo that draws several. `DemoState` writes its title into an `h3` and
 * the state is the `section` around it; Select and ComboBox have one `data-state` for all their
 * specimens, so the title is the only name that a specimen has. The title is found by its text and
 * not by its role: React Aria takes everything but the open list out of the accessibility tree,
 * the headings with it, and a role query for the specimen would then find nothing.
 */
function titled(page: Page, demo: string, title: string): Locator {
  return page
    .locator(`[data-demo="${demo}"] section`)
    .filter({ has: page.locator("h3").getByText(title, { exact: true }) });
}

/**
 * How many elements assistive technology cannot reach. React Aria marks the page around an open
 * overlay (`aria-hidden`, or `inert`) and has to take the marks back when the overlay goes. jsdom
 * ends with the test, so a mark that outlives its overlay is only ever seen in a real page (R1-22).
 */
async function countHiddenFromAssistiveTechnology(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[aria-hidden="true"], [inert]').length);
}

/** Whether the page's `main` is out of reach of assistive technology, as it is behind a modal. */
async function isPageHidden(page: Page): Promise<boolean> {
  return page
    .locator("main")
    .evaluate((main) => main.closest('[aria-hidden="true"], [inert]') !== null);
}

/** The page is as it was before the overlay opened: nothing is left hidden from assistive technology. */
async function expectPageRestored(page: Page, hiddenAtRest: number): Promise<void> {
  await expect.poll(() => countHiddenFromAssistiveTechnology(page)).toBe(hiddenAtRest);
}

/** Keyboard focus is on `overlay` or on something inside it. */
async function expectFocusInside(overlay: Locator): Promise<void> {
  await expect
    .poll(() => overlay.evaluate((node) => node.contains(document.activeElement)))
    .toBe(true);
}

/**
 * Presses Escape and expects `overlay` to be gone within a second, with focus on `opener`. An
 * overlay leaves when its exit animation has ended, which is a rendering update, and a browser
 * short of CPU runs those late (see `settleAnimations`): the animation is taken to its end, and
 * the second is the time that the page then has to remove the node.
 */
async function leaveWithEscape(page: Page, overlay: Locator, opener: Locator): Promise<void> {
  await page.keyboard.press("Escape");
  await settleAnimations(page);

  await expect(overlay).toHaveCount(0, { timeout: LEAVES_WITHIN_MS });
  await expect(opener).toBeFocused();
}

/** A CSS time as milliseconds: the build's minifier writes `250ms` as `.25s`. */
function inMilliseconds(durations: Readonly<Record<string, string>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(durations).map(([name, value]) => [
      name,
      Math.round(Number.parseFloat(value) * (value.endsWith("ms") ? 1 : 1000)),
    ]),
  );
}

test.describe("the real overlays", () => {
  test("a tooltip opened with the keyboard names its trigger and has no axe violations", async ({
    page,
  }) => {
    await openDesign(page, { sections: ["Tooltip"] });
    const trigger = specimen(page, "Tooltip", "closed").getByRole("button", { name: "Swap" });

    await focusWithKeyboard(page, trigger);

    await expect(page.getByRole("tooltip")).toHaveText("Swap origin and destination");
    await expect(trigger).toHaveAccessibleDescription("Swap origin and destination");
    await expectNoAxeViolations(page, { regions: false });
  });

  /**
   * The popover from the keyboard to Escape. With `stalled`, every animation and transition of the
   * page takes an hour: a browser that draws no frame advances none, and that is the state that a
   * WebKit on a loaded runner was in for 5 s after the popover mounted (see `settleAnimations`),
   * made reproducible without any load.
   */
  async function openScanAndCloseThePopover(
    page: Page,
    { stalled }: { readonly stalled: boolean },
  ): Promise<void> {
    await openDesign(page, { sections: ["Popover"] });
    if (stalled) {
      await page.addStyleTag({
        content:
          "*, *::before, *::after { animation-duration: 3600s !important; transition-duration: 3600s !important; }",
      });
    }
    const trigger = specimen(page, "Popover", "closed").getByRole("button", { name: "Legend" });
    await focusWithKeyboard(page, trigger);

    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Legend" });
    await expect(dialog).toContainText("Checkpoint 7");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    // axe only recognises an open modal (the two page rules, landmark-one-main and
    // page-has-heading-one, pass for a modal because the page behind it is inert) when the dialog
    // is visible, and it reads a dialog at opacity 0 as hidden. The popover enters from opacity 0,
    // so a scan that starts before the browser has run the enter animation sees no modal and
    // reports the inert page as having no main and no h1. A browser that is short of CPU runs its
    // rendering updates late (1.6 s in the trace of a CI failure; no update at all for 5 s after
    // the popover mounted in a WebKit run on a loaded runner, while the page still answered every
    // script), so the test does not wait for the animation: it takes it to its end state.
    await settleAnimations(page);
    await expect(page.locator('[data-trigger="DialogTrigger"]')).toHaveCSS("opacity", "1");
    await expectNoAxeViolations(page, { regions: false });

    await page.keyboard.press("Escape");
    // The popover leaves when its exit animation has ended, which is a rendering update too.
    await settleAnimations(page);

    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }

  test("a popover opened with the keyboard takes focus, has no axe violations, and gives focus back on Escape", async ({
    page,
  }) => {
    await openScanAndCloseThePopover(page, { stalled: false });
  });

  test("a popover opened with the keyboard is scanned and closed while the browser advances no animation", async ({
    page,
  }) => {
    await openScanAndCloseThePopover(page, { stalled: true });
  });

  /*
   * R3-05. The other overlays, opened and closed the way a keyboard visitor does it. Each test
   * opens its overlay with the keys, scans the page with the overlay open (every axe rule but
   * `region`, see `expectNoAxeViolations`), closes it, and checks that it is gone within a second,
   * that focus is where it belongs and that the page is as it was before. A component that has no
   * Escape, or no focus to give back, says so in its test and is checked on what it does have.
   */

  test("a dialog opened with the keyboard takes focus, hides the page, has no axe violations, and gives focus back on Escape", async ({
    page,
  }) => {
    await openDesign(page, { sections: ["Dialog"] });
    const hiddenAtRest = await countHiddenFromAssistiveTechnology(page);
    const opener = specimen(page, "Dialog", "confirmation").getByRole("button", {
      name: "Clear recent searches",
    });
    await focusWithKeyboard(page, opener);

    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Clear recent searches?" });
    await expect(dialog).toContainText("This removes the places saved on this device.");
    await expectFocusInside(dialog);
    // A modal: the page behind it is out of reach of assistive technology while it is open.
    await expect.poll(() => isPageHidden(page)).toBe(true);
    await expectNoAxeViolations(page, { regions: false });

    await leaveWithEscape(page, dialog, opener);
    await expectPageRestored(page, hiddenAtRest);
  });

  test("a select opened with the keyboard lists its options, has no axe violations, and gives focus back on Escape", async ({
    page,
  }) => {
    await openDesign(page, { sections: ["Select"] });
    const hiddenAtRest = await countHiddenFromAssistiveTechnology(page);
    const trigger = titled(page, "Select", "Default").getByRole("button", {
      name: /Weather source/u,
    });
    await focusWithKeyboard(page, trigger);

    await page.keyboard.press("Enter");

    const list = page.getByRole("listbox", { name: "Weather source" });
    await expect(list.getByRole("option")).toHaveCount(3);
    await expect(list.getByRole("option", { selected: true })).toHaveAccessibleName(
      "Live forecast (Open-Meteo)",
    );
    await expectFocusInside(list);
    await expectNoAxeViolations(page, { regions: false, known: OPTIONS_WITH_A_DESCRIPTION });

    await leaveWithEscape(page, list, trigger);
    await expectPageRestored(page, hiddenAtRest);
  });

  test("a combo box focused with the keyboard lists its recent places, has no axe violations, and keeps focus when Escape closes the list", async ({
    page,
  }) => {
    await openDesign(page, { sections: ["ComboBox"] });
    const hiddenAtRest = await countHiddenFromAssistiveTechnology(page);
    // The "Recent" specimen opens its list when the input takes focus. The list keeps one side of
    // the input (D-55), so the test does not look at which.
    const input = titled(page, "ComboBox", "Recent places (opens on focus)").getByRole("combobox", {
      name: "Origin",
    });

    await focusWithKeyboard(page, input);

    const list = page.getByRole("listbox");
    await expect(list.getByRole("option")).toHaveCount(2);
    await expect(input).toHaveAttribute("aria-expanded", "true");
    await expectNoAxeViolations(page, { regions: false, known: OPTIONS_WITH_A_DESCRIPTION });

    // The input is the combo box's focus: it holds it while the list is open, so the focus that
    // the list gives back after Escape is the one it never took.
    await leaveWithEscape(page, list, input);
    await expect(input).toHaveAttribute("aria-expanded", "false");
    await expectPageRestored(page, hiddenAtRest);
  });

  test("a date picker opened with the keyboard shows its calendar, has no axe violations, and gives focus back on Escape", async ({
    page,
  }) => {
    await openDesign(page, { sections: ["DatePicker"] });
    const hiddenAtRest = await countHiddenFromAssistiveTechnology(page);
    const opener = specimen(page, "DatePicker", "departure-en-us").getByRole("button", {
      name: /^Calendar/u,
    });
    await focusWithKeyboard(page, opener);

    await page.keyboard.press("Enter");

    const calendar = page.getByRole("dialog");
    await expect(calendar.getByRole("grid")).toBeVisible();
    await expectFocusInside(calendar);
    await expectNoAxeViolations(page, { regions: false });

    await leaveWithEscape(page, calendar, opener);
    await expectPageRestored(page, hiddenAtRest);
  });

  /*
   * The toast. Escape is not a key of a toast: React Aria's toast region has no handler for it, and
   * DESIGN.md (Toast) gives a toast a close button and an action, and no key. So the tests close a
   * toast the way a keyboard visitor can, with Enter on its close button, and check where focus goes.
   * The error toast is the one used: it carries an action, so it stays until it is closed, and the
   * 5 s of a success or an info toast cannot run out in the middle of a slow runner's test.
   *
   * The region is drawn into the end of the page and is not a tab stop (`tabindex` -1), so Tab
   * would reach it only after everything else on the page. F6, React Aria's landmark key, is how
   * the keyboard gets there (DESIGN.md names it): it puts focus on the region, and Tab goes on
   * to the action and the close button. React Aria's region and the toast both remember the
   * control that had focus before it went in, the one that raised the toast, and DESIGN.md says
   * that focus goes back to it.
   */
  const COPY_FAILED = "Couldn't copy. Select the address bar and copy it.";

  function toastRegion(page: Page): Locator {
    return page.getByRole("region", { name: /notification/u });
  }

  test("a toast raised with the keyboard is announced once, has no axe violations, and gives focus back when it is dismissed", async ({
    page,
  }) => {
    await openDesign(page, { sections: ["Toast"] });
    const raise = specimen(page, "Toast", "error").getByRole("button", {
      name: "Show error toast",
    });
    await focusWithKeyboard(page, raise);

    await page.keyboard.press("Enter");

    const region = toastRegion(page);
    await expect(region.getByText(COPY_FAILED)).toBeVisible();
    // Announced politely, and once (R3-06): one status element holds the words, and the toast
    // itself is not a live region.
    const announcement = page.getByRole("status").filter({ hasText: COPY_FAILED });
    await expect(announcement).toHaveCount(1);
    await expect(announcement).toHaveAttribute("aria-live", "polite");
    await expectNoAxeViolations(page, { regions: false });

    await page.keyboard.press("F6");
    await expect(region).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(region.getByRole("button", { name: "Try again" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(region.getByRole("button", { name: "Dismiss message" })).toBeFocused();

    await page.keyboard.press("Enter");

    await expect(region).toHaveCount(0, { timeout: LEAVES_WITHIN_MS });
    await expect(raise).toBeFocused();
  });

  test("a toast that closes while it holds focus hands focus back, with the next toast taking its place", async ({
    page,
  }) => {
    await openDesign(page, { sections: ["Toast"] });
    const raise = specimen(page, "Toast", "error").getByRole("button", {
      name: "Show error toast",
    });
    await focusWithKeyboard(page, raise);
    // Two toasts: the queue shows one at a time, the newest first, and keeps the other behind it.
    // When the one that shows closes, the region stays and shows the next, so React Aria's region
    // moves no focus (it looks for role=alertdialog, which a toast of this design system has not):
    // only the toast's own hand-back keeps focus out of the void.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    const region = toastRegion(page);
    const dismiss = region.getByRole("button", { name: "Dismiss message" });

    await page.keyboard.press("F6");
    await expect(region).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(dismiss).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(raise).toBeFocused();
    await expect(region.getByText(COPY_FAILED)).toBeVisible();

    await page.keyboard.press("F6");
    await expect(region).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(dismiss).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(region).toHaveCount(0, { timeout: LEAVES_WITHIN_MS });
    await expect(raise).toBeFocused();
  });

  /*
   * The bottom sheet is a region over a map that stays usable, not a modal (DESIGN.md,
   * BottomSheet): it takes no focus when it appears, it has no Escape, and what closes it is its
   * parent. So the test reads the contract as: the sheet leaves focus on the control that showed
   * it, answers the keys of its handle, ignores Escape, and goes when that control hides it.
   */
  test("a bottom sheet shown with the keyboard leaves focus where it was, has no axe violations, answers its handle, ignores Escape, and goes when it is hidden", async ({
    page,
  }) => {
    await openDesign(page, { sections: ["BottomSheet"] });
    const toggle = specimen(page, "BottomSheet", "states").getByRole("button", {
      name: /^(Show|Hide) the sheet$/u,
    });
    await focusWithKeyboard(page, toggle);

    await page.keyboard.press("Enter");

    const sheet = page.getByRole("region", { name: "Trip planner" });
    await expect(sheet).toHaveAttribute("data-snap", "half");
    await expect(toggle).toHaveText("Hide the sheet");
    await expect(toggle).toBeFocused();
    await expectNoAxeViolations(page, { regions: false });

    const handle = sheet.getByRole("button", { name: "Resize panel" });
    await focusWithKeyboard(page, handle);
    await page.keyboard.press("Enter");
    await expect(sheet).toHaveAttribute("data-snap", "full");
    await expect(handle).toHaveAttribute("aria-expanded", "true");
    await expect(sheet.getByRole("status")).toHaveText("Panel fully open");

    // A sheet that Escape had moved would be at peek for the ArrowDown, which then leaves it
    // there: it steps from full to half only if Escape left it at full.
    await page.keyboard.press("Escape");
    await page.keyboard.press("ArrowDown");
    await expect(sheet).toHaveAttribute("data-snap", "half");
    await expect(handle).toBeFocused();

    await focusWithKeyboard(page, toggle);
    await page.keyboard.press("Enter");

    await expect(sheet).toHaveCount(0, { timeout: LEAVES_WITHIN_MS });
    await expect(toggle).toHaveText("Show the sheet");
    await expect(toggle).toBeFocused();
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

  const MOVING = ["Spinner", "Skeleton"];

  test("the spinner and the skeleton are in motion when motion is not reduced", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await openDesign(page, { sections: MOVING });

    const running = await animations(page);

    expect(running["spinner"]).not.toMatch(/^(none|missing)$/);
    expect(running["skeleton"]).not.toMatch(/^(none|missing)$/);
  });

  test.describe("when the visitor asks for less", () => {
    test.use({ reducedMotion: "reduce" });

    test("the spinner is still and the skeleton holds one static level", async ({ page }) => {
      await openDesign(page, { sections: MOVING });

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
      await openDesign(page, { sections: [PAGE_ONLY_SECTION] });

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

      expect(inMilliseconds(durations)).toEqual({
        fast: 0,
        base: 0,
        slow: 0,
        sheet: 0,
        camera: 0,
        skeleton: 0,
        spinner: 0,
        // Intervals, not animations (R1-16): zeroing them would make Play step through all 48
        // hours back to back, and make a tooltip open before the pointer has rested.
        frame: 250,
        "tooltip-delay": 400,
      });
    });
  });
});

interface Target {
  readonly name: string;
  /** The section of `/design` that holds the target: the only one the test loads. */
  readonly section: string;
  readonly locate: (page: Page) => Locator;
}

const TARGETS: readonly Target[] = [
  {
    name: "a Button",
    section: "Button",
    locate: (page) =>
      specimen(page, "Button", "primary").getByRole("button", { name: "Plan routes" }),
  },
  {
    name: "an IconButton",
    section: "IconButton",
    locate: (page) =>
      specimen(page, "IconButton", "ghost").getByRole("button", { name: "Copy link" }),
  },
  {
    name: "a Chip",
    section: "Chip",
    locate: (page) => specimen(page, "Chip", "unselected").getByRole("button", { name: "Wind" }),
  },
  {
    name: "a Segmented item",
    section: "Segmented",
    locate: (page) =>
      labelOf(specimen(page, "Segmented", "interval").getByRole("radio", { name: "10 mi" })),
  },
  {
    name: "a ThemeToggle item",
    section: "ThemeToggle",
    locate: (page) =>
      labelOf(specimen(page, "ThemeToggle", "system").getByRole("radio", { name: "Light theme" })),
  },
  {
    name: "a Switch",
    section: "Switch",
    locate: (page) => page.locator("[data-demo='Switch'] label").first(),
  },
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
        await openDesign(page, { sections: [target.section] });
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
