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
  // A golden of fallback fonts would be a golden of the wrong thing.
  await page.evaluate(() => document.fonts.ready);
}
