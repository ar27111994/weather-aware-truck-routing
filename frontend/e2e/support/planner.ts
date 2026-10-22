import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * 9:00 in Denver. The page's own clock is pinned to it, so "Now", the arrival times and the visual
 * goldens read the same on every machine and every day.
 */
export const NOW = new Date("2026-10-21T15:00:00Z");

/** The two places the mock backend has recorded routes for, in the address's `label@lat,lon` form. */
const PLACES = {
  saltLakeCity: "Salt Lake City, Utah, United States@40.7608,-111.891",
  denver: "Denver, Colorado, United States@39.7392,-104.9903",
} as const;

/**
 * The address of the planner with the Salt Lake City to Denver trip already in the form (R9):
 * a link someone shared, before anyone pressed Plan routes.
 *
 * @param scenario - A scenario id, or `null` for the live forecast.
 */
export function tripAddress(scenario: string | null = "calm"): string {
  const query = new URLSearchParams({
    origin: PLACES.saltLakeCity,
    destination: PLACES.denver,
    depart: "2026-10-21T16:00:00Z",
    load: "38000",
    interval: "25",
  });
  if (scenario !== null) query.set("scenario", scenario);
  return `/?${query.toString()}`;
}

/**
 * Opens the planner and waits until the browser has taken the page over: only the browser knows
 * what time it is, so the departure fields have a value exactly when the page is interactive.
 *
 * The planner's code is a separate download that starts when the visitor first gives the page an
 * input (the ADR in docs/adr/intent-gated-hydration-of-the-planner.md), so this gives it one, the way a visitor does: the pointer moves over the panel.
 * There is no test-only switch that loads it.
 */
export async function openPlanner(
  page: Page,
  address = "/",
  // How the departure date reads in the page's language (the default is the English one).
  date = "10/21/2026",
): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto(address);
  await wakePlanner(page);
  await expect(page.getByRole("group", { name: "Date" })).toContainText(date);
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Gives the prerendered page its first input, the way a visitor who is about to use it does: the
 * pointer moves over the planner's panel. That starts the download of the planner's code.
 */
export async function wakePlanner(page: Page): Promise<void> {
  const panel = page.locator("[data-planner-panel]");
  // `boundingBox` does not wait for the panel to be drawn: a loaded machine can reach it first.
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  if (box === null) throw new Error("The planner's panel is not on the page.");
  await page.mouse.move(box.x + 8, box.y + 8);
}

/** Types the trip into the form the way a person does: search, pick from the list, pick a load. */
export async function chooseTrip(page: Page): Promise<void> {
  await page.getByRole("combobox", { name: /^From/u }).fill("salt");
  await page.getByRole("option", { name: /Salt Lake City/u }).click();
  await page.getByRole("combobox", { name: /^To/u }).fill("denv");
  await page.getByRole("option", { name: /Denver/u }).click();
  await page.getByRole("button", { name: "38,000" }).click();
}
