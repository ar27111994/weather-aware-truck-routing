import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

export type ThemeName = "light" | "dark";

const COMPONENTS_DIR = fileURLToPath(
  new URL("../../app/design-system/components/", import.meta.url),
);

/**
 * Every component section of `/design`: every folder of `components/` that has a demo. A folder
 * without one (`_shared`, the parts the field components share) is not a section: the page has
 * nothing of it to scan or to tab through. `demo-registry.test.tsx` pins that one folder is one
 * section.
 */
export const SECTIONS: readonly string[] = readdirSync(COMPONENTS_DIR, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() && existsSync(`${COMPONENTS_DIR}${entry.name}/${entry.name}.demo.tsx`),
  )
  .map((entry) => entry.name)
  .toSorted((left, right) => left.localeCompare(right, "en"));

/**
 * The smallest section there is, for a test that needs the page and its chrome but none of the
 * components: a rule between two blocks, with no script of its own.
 */
export const PAGE_ONLY_SECTION = "Divider";

/**
 * Puts the page at rest: every finite animation and transition is taken to its end state, and the
 * script waits until each has reported it. The infinite ones (spinner, skeleton) never end and are
 * left running.
 *
 * A browser advances an animation on its rendering updates, and a browser that is short of CPU
 * runs them late: in the traces of a WebKit run on a loaded GitHub runner the page painted once
 * after the popover had mounted and not again for 5 s, while the page answered every script at
 * once, so the popover's enter animation sat at progress 0 (opacity 0, `data-entering`) for the
 * whole of an `expect`. axe reads a computed opacity below 1 as a lighter colour, and a modal at
 * opacity 0 as hidden (so it reports the inert page behind it as having no main and no h1), so a
 * scan of a page that is not at rest depends on the browser's frame clock and not on the page.
 * Finishing the animations (Web Animations API) is a state of the page and not a time, it needs no
 * rendering update, and a test that does not check the motion itself has no use for the motion.
 * The tests that are about the motion (`overlays.spec.ts`, `reduced motion`) do not call it.
 *
 * @param page - The page of the test.
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    for (const animation of finite) {
      animation.finish();
    }
    // An animation that its element's removal cancelled has nothing left to report.
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

export interface OpenDesignOptions {
  /** The theme the page is saved with, as a returning visitor would have it. The default is the system's. */
  readonly theme?: ThemeName;
  /**
   * The sections to load, by name (`/design?section=Name`). A page that loads one section costs
   * what one section costs, however many components the design system has, and its tests cannot
   * touch another section's specimens. Leave it out for the whole page, which only the tests that
   * are about the whole page should do.
   */
  readonly sections?: readonly string[];
}

/**
 * Opens `/design` and waits until the page is what the test is about: the heading is there, the
 * theme is set, every section asked for has its specimens (a section that is still loading is only
 * a placeholder, marked busy, and a test must not read it), and the fonts are in. A name that no
 * component has never shows up, so such a test fails here and says why, instead of finding an empty
 * page.
 *
 * @param page - The page of the test.
 * @param options - The theme to save and the sections to load.
 */
export async function openDesign(page: Page, options: OpenDesignOptions = {}): Promise<void> {
  const { theme, sections } = options;
  if (theme !== undefined) {
    await page.addInitScript((saved) => {
      window.localStorage.setItem("hc-theme", saved);
    }, theme);
  }
  const query =
    sections === undefined
      ? ""
      : `?${sections.map((name) => `section=${encodeURIComponent(name)}`).join("&")}`;
  await page.goto(`/design${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "Design system" })).toBeVisible();
  if (theme !== undefined) {
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  }
  await expect(page.locator("section[data-demo]")).toHaveCount((sections ?? SECTIONS).length);
  await expect(page.locator('section[aria-busy="true"]')).toHaveCount(0);
  // A section that has just mounted may still be fading in (the banner reveals itself from opacity 0),
  // and a golden or a scan of it would be of a moment, not of the page.
  await settleAnimations(page);
  // A golden of fallback fonts would be a golden of the wrong thing.
  await page.evaluate(() => document.fonts.ready);
}
