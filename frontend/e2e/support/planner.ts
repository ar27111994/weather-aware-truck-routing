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
 * what time it is, so the departure fields have a value exactly when the page is interactive. Typing
 * before that would be lost when the page hydrates.
 */
export async function openPlanner(page: Page, address = "/"): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto(address);
  await expect(page.getByRole("group", { name: "Date" })).toContainText("10/21/2026");
  await page.evaluate(() => document.fonts.ready);
}

/** Types the trip into the form the way a person does: search, pick from the list, pick a load. */
export async function chooseTrip(page: Page): Promise<void> {
  await page.getByRole("combobox", { name: /^From/u }).fill("salt");
  await page.getByRole("option", { name: /Salt Lake City/u }).click();
  await page.getByRole("combobox", { name: /^To/u }).fill("denv");
  await page.getByRole("option", { name: /Denver/u }).click();
  await page.getByRole("button", { name: "38,000" }).click();
}
