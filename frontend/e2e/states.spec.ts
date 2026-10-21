import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { openDesign } from "./support/design";

/**
 * What hover, press and keyboard focus look like in a real engine (DESIGN.md sections 10 and 8.1).
 * The Vitest suites prove each state reaches the `data-*` attribute that the CSS keys on; jsdom
 * loads no stylesheet, so only here does a rule that never matches, or loses the cascade, show up.
 * Each table row is one control on `/design`; the expected colours are the design tokens, resolved
 * by the page itself, so the tests follow a re-themed palette and still fail on a dead rule. Each
 * row names the section that holds its control, and its test loads that section only (D-35).
 */

/** One specimen (a demo section's state) on `/design`. */
function specimen(page: Page, demo: string, state: string): Locator {
  return page.locator(`[data-demo="${demo}"] [data-state="${state}"]`);
}

/** What a design token computes to as a colour in this page, in the theme the page is in. */
function colorOf(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, token);
}

/** What a design token computes to as a length, such as the focus ring's width. */
function lengthOf(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.width = `var(${name})`;
    document.body.append(probe);
    const length = getComputedStyle(probe).width;
    probe.remove();
    return length;
  }, token);
}

/** What `var(--focus-halo-shadow)` computes to as a box shadow in this page. */
function haloShadow(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.boxShadow = "var(--focus-halo-shadow)";
    document.body.append(probe);
    const shadow = getComputedStyle(probe).boxShadow;
    probe.remove();
    return shadow;
  });
}

/** The element's computed `box-shadow`. */
function boxShadowOf(element: Locator): Promise<string> {
  return element.evaluate((node) => getComputedStyle(node).boxShadow);
}

/** The element's scale, from its `transform` and its `scale` property together. */
function scaleOf(element: Locator): Promise<number> {
  return element.evaluate((node) => {
    const style = getComputedStyle(node);
    const matrix = style.transform === "none" ? new DOMMatrix() : new DOMMatrix(style.transform);
    const scale = style.scale === "none" ? 1 : Number(style.scale.split(" ")[0]);
    return matrix.a * scale;
  });
}

/**
 * Puts keyboard focus on `target` the way a keyboard user gets there: by Tab. React Aria shows a
 * focus ring only when the last input was the keyboard, and a script's `focus()` is not that.
 */
async function focusWithKeyboard(page: Page, target: Locator): Promise<void> {
  await target.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
}

/**
 * The label that draws a radio. React Aria puts hover, press and focus-visible on the `<label>`
 * (D-26), not on the visually hidden `<input type="radio">` that has the `radio` role.
 */
function labelOf(radio: Locator): Locator {
  return radio.locator("xpath=ancestor::label");
}

interface HoverCase {
  readonly name: string;
  /** The section of `/design` that holds the control: the only one the test loads. */
  readonly section: string;
  readonly point: (page: Page) => Locator;
  /** The token that fills the control while the pointer rests on it. */
  readonly fill: string;
}

// Generic hover (DESIGN.md section 10): `--color-surface-hover`, or `--color-ink-hover` for ink
// fills. The Switch is not here: its track and thumb have no hover style.
const HOVER_CASES: readonly HoverCase[] = [
  {
    name: "a secondary Button",
    section: "Button",
    point: (page) =>
      specimen(page, "Button", "secondary").getByRole("button", { name: "Edit trip" }),
    fill: "--color-surface-hover",
  },
  {
    name: "a primary Button",
    section: "Button",
    point: (page) =>
      specimen(page, "Button", "primary").getByRole("button", { name: "Plan routes" }),
    fill: "--color-ink-hover",
  },
  {
    name: "an IconButton",
    section: "IconButton",
    point: (page) =>
      specimen(page, "IconButton", "ghost").getByRole("button", { name: "Copy link" }),
    fill: "--color-surface-hover",
  },
  {
    name: "a Chip",
    section: "Chip",
    point: (page) => specimen(page, "Chip", "unselected").getByRole("button", { name: "Wind" }),
    fill: "--color-surface-hover",
  },
  {
    name: "a Segmented item",
    section: "Segmented",
    point: (page) =>
      labelOf(specimen(page, "Segmented", "interval").getByRole("radio", { name: "10 mi" })),
    fill: "--color-surface-hover",
  },
  {
    name: "a ThemeToggle item",
    section: "ThemeToggle",
    point: (page) =>
      labelOf(specimen(page, "ThemeToggle", "system").getByRole("radio", { name: "Light theme" })),
    fill: "--color-surface-hover",
  },
  {
    name: "a Slider thumb",
    section: "Slider",
    point: (page) => specimen(page, "Slider", "generic").getByRole("slider").locator("xpath=../.."),
    fill: "--color-ink-hover",
  },
  {
    name: "a NumberField stepper",
    section: "NumberField",
    point: (page) =>
      specimen(page, "NumberField", "states")
        .getByRole("button", { name: "Decrease load by 1,000 lb" })
        .first(),
    fill: "--color-surface-hover",
  },
  {
    name: "a Tab",
    section: "Tabs",
    point: (page) =>
      specimen(page, "Tabs", "states").getByRole("tab", { name: "Risk profile" }).first(),
    fill: "--color-surface-hover",
  },
  {
    name: "a sortable Table header",
    section: "Table",
    point: (page) =>
      specimen(page, "Table", "default").getByRole("columnheader", { name: /Distance/ }),
    fill: "--color-surface-hover",
  },
  {
    // Checkpoint 4 is the selected row of this specimen; it keeps its own fill under the pointer.
    name: "a Table row",
    section: "Table",
    point: (page) => specimen(page, "Table", "default").getByRole("row").nth(2),
    fill: "--color-surface-hover",
  },
];

interface PressCase {
  readonly name: string;
  /** The section of `/design` that holds the control: the only one the test loads. */
  readonly section: string;
  readonly point: (page: Page) => Locator;
  /** The element that is drawn pressed, when it is not the one the pointer is on. */
  readonly painted?: (pointed: Locator) => Locator;
  /** The token that fills the element while pressed. */
  readonly fill?: string;
  /** Pressed controls sink by 1 px (DESIGN.md section 10: pressed colour plus `translateY(1px)`). */
  readonly sinks?: boolean;
  /** The scale the element is drawn at while pressed. */
  readonly scale?: number;
}

const PRESS_CASES: readonly PressCase[] = [
  {
    name: "a secondary Button",
    section: "Button",
    point: (page) =>
      specimen(page, "Button", "secondary").getByRole("button", { name: "Edit trip" }),
    fill: "--color-surface-pressed",
    sinks: true,
  },
  {
    name: "a primary Button",
    section: "Button",
    point: (page) =>
      specimen(page, "Button", "primary").getByRole("button", { name: "Plan routes" }),
    fill: "--color-ink-pressed",
    sinks: true,
  },
  {
    name: "an IconButton",
    section: "IconButton",
    point: (page) =>
      specimen(page, "IconButton", "ghost").getByRole("button", { name: "Copy link" }),
    fill: "--color-surface-pressed",
    sinks: true,
  },
  {
    name: "a Chip",
    section: "Chip",
    point: (page) => specimen(page, "Chip", "unselected").getByRole("button", { name: "Wind" }),
    fill: "--color-surface-pressed",
    sinks: true,
  },
  {
    name: "a Segmented item",
    section: "Segmented",
    point: (page) =>
      labelOf(specimen(page, "Segmented", "interval").getByRole("radio", { name: "10 mi" })),
    fill: "--color-surface-pressed",
  },
  {
    name: "a ThemeToggle item",
    section: "ThemeToggle",
    point: (page) =>
      labelOf(specimen(page, "ThemeToggle", "system").getByRole("radio", { name: "Light theme" })),
    fill: "--color-surface-pressed",
  },
  {
    name: "a Switch thumb",
    section: "Switch",
    point: (page) => specimen(page, "Switch", "off").locator("label"),
    painted: (row) => row.locator("[aria-hidden='true'] > span"),
    scale: 0.94,
  },
  {
    name: "a Slider thumb",
    section: "Slider",
    point: (page) => specimen(page, "Slider", "generic").getByRole("slider").locator("xpath=../.."),
    fill: "--color-ink-pressed",
    scale: 1.1,
  },
  {
    name: "a NumberField stepper",
    section: "NumberField",
    point: (page) =>
      specimen(page, "NumberField", "states")
        .getByRole("button", { name: "Decrease load by 1,000 lb" })
        .first(),
    fill: "--color-surface-pressed",
    sinks: true,
  },
  {
    name: "a Tab",
    section: "Tabs",
    point: (page) =>
      specimen(page, "Tabs", "states").getByRole("tab", { name: "Risk profile" }).first(),
    fill: "--color-surface-pressed",
  },
  {
    name: "a sortable Table header",
    section: "Table",
    point: (page) =>
      specimen(page, "Table", "default").getByRole("columnheader", { name: /Distance/ }),
    fill: "--color-surface-pressed",
  },
  {
    name: "a Table row",
    section: "Table",
    point: (page) => specimen(page, "Table", "default").getByRole("row").nth(2),
    fill: "--color-surface-pressed",
  },
];

interface FocusCase {
  readonly name: string;
  /** The section of `/design` that holds the control: the only one the test loads. */
  readonly section: string;
  /** What takes keyboard focus. */
  readonly focus: (page: Page) => Locator;
  /** The element that draws the ring, when it is not the one that has focus. */
  readonly ringOn?: (focused: Locator) => Locator;
  /** Whether the ring has the halo behind it: ink fills and map overlays do, plain surfaces do not. */
  readonly halo?: boolean;
}

const FOCUS_CASES: readonly FocusCase[] = [
  {
    name: "a Button",
    section: "Button",
    focus: (page) =>
      specimen(page, "Button", "secondary").getByRole("button", { name: "Edit trip" }),
  },
  {
    name: "an IconButton",
    section: "IconButton",
    focus: (page) =>
      specimen(page, "IconButton", "ghost").getByRole("button", { name: "Copy link" }),
  },
  {
    name: "a Chip",
    section: "Chip",
    focus: (page) => specimen(page, "Chip", "unselected").getByRole("button", { name: "Wind" }),
  },
  {
    // A radio group has one tab stop, the selected radio (D-26), so the keyboard reaches that one;
    // the label around the hidden input shows the ring.
    name: "a Segmented item",
    section: "Segmented",
    focus: (page) => specimen(page, "Segmented", "interval").getByRole("radio", { name: "25 mi" }),
    ringOn: labelOf,
  },
  {
    name: "a ThemeToggle item",
    section: "ThemeToggle",
    focus: (page) =>
      specimen(page, "ThemeToggle", "system").getByRole("radio", { name: "Match system theme" }),
    ringOn: labelOf,
  },
  {
    // The input that takes focus is visually hidden; the track is what shows the ring.
    name: "a Switch",
    section: "Switch",
    focus: (page) => specimen(page, "Switch", "off").getByRole("switch"),
    ringOn: (focused) => focused.locator("xpath=ancestor::label").locator("[aria-hidden='true']"),
  },
  {
    // Likewise the slider's input; the thumb around it shows the ring.
    name: "a Slider",
    section: "Slider",
    focus: (page) => specimen(page, "Slider", "generic").getByRole("slider"),
    ringOn: (focused) => focused.locator("xpath=../.."),
  },
  {
    // The ring of a field sits on the panel surface: no halo (section 8.1 asks for it on ink fills
    // and over the map only).
    name: "a TextField",
    section: "TextField",
    focus: (page) =>
      specimen(page, "TextField", "states").getByRole("textbox", { name: "Plan name" }).first(),
    halo: false,
  },
  {
    // A tab list has one tab stop, the selected tab.
    name: "a Tab",
    section: "Tabs",
    focus: (page) =>
      specimen(page, "Tabs", "states").getByRole("tab", { name: "Checkpoints" }).first(),
    halo: false,
  },
];

test.describe("hover", () => {
  for (const hover of HOVER_CASES) {
    test(`${hover.name} takes its hover fill while the pointer rests on it`, async ({ page }) => {
      await openDesign(page, { sections: [hover.section] });
      const canHover = await page.evaluate(() => window.matchMedia("(hover: hover)").matches);
      test.skip(!canHover, "this device has no hover");
      const control = hover.point(page);
      const fill = await colorOf(page, hover.fill);
      // If the hover fill were the resting colour too, the check below would prove nothing.
      await expect(control).not.toHaveCSS("background-color", fill);

      await control.hover();

      await expect(control).toHaveCSS("background-color", fill);
    });
  }
});

test.describe("pressed", () => {
  for (const press of PRESS_CASES) {
    test(`${press.name} is drawn pressed while a pointer button is held down on it`, async ({
      page,
    }) => {
      await openDesign(page, { sections: [press.section] });
      const pointed = press.point(page);
      const painted = press.painted?.(pointed) ?? pointed;

      await pointed.hover();
      await page.mouse.down();
      try {
        if (press.fill !== undefined) {
          await expect(painted).toHaveCSS("background-color", await colorOf(page, press.fill));
        }
        if (press.sinks === true) {
          await expect(painted).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 1)");
        }
        if (press.scale !== undefined) {
          await expect.poll(() => scaleOf(painted)).toBeCloseTo(press.scale, 2);
        }
      } finally {
        await page.mouse.up();
      }
    });
  }
});

test.describe("keyboard focus", () => {
  for (const focus of FOCUS_CASES) {
    test(`${focus.name} draws the focus ring when the keyboard reaches it`, async ({ page }) => {
      await openDesign(page, { sections: [focus.section] });
      const focused = focus.focus(page);
      const ring = focus.ringOn?.(focused) ?? focused;
      const halo = await haloShadow(page);
      const withHalo = focus.halo !== false;
      await expect(ring).toHaveCSS("outline-style", "none");
      expect(await boxShadowOf(ring)).not.toContain(halo);

      await focusWithKeyboard(page, focused);

      // DESIGN.md section 8.1: `outline: var(--focus-width) solid var(--color-focus-ring)`, with the
      // halo behind it. `base.css` draws the outline on every `:focus-visible` element, so the
      // outline alone would pass with a component's own rule dead; the halo is that rule's own.
      // A control on a plain surface has no halo, so there the outline is all there is to see.
      await expect(ring).toHaveCSS("outline-style", "solid");
      await expect(ring).toHaveCSS("outline-width", await lengthOf(page, "--focus-width"));
      await expect(ring).toHaveCSS("outline-color", await colorOf(page, "--color-focus-ring"));
      if (withHalo) {
        await expect.poll(() => boxShadowOf(ring)).toContain(halo);
      }
    });
  }
});
