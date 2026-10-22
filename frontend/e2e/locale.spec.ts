import { expect, test } from "./support/mock-api.ts";
import { openPlanner, tripAddress } from "./support/planner.ts";
import type { Page } from "@playwright/test";

// D-28: clocks follow the visitor's language, through the browser's own `Intl`. The build keeps only
// the English strings of React Aria (N1, vite.config.ts), so these tests pin what that must not
// change: a German browser still gets a German clock (24 hours, the day before the month) in the
// form and in the results, with English words around it, and nothing is reported on the way.
test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

/** Everything the page reports as a problem while a test runs: errors, and React's own warnings. */
function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      problems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    problems.push(`pageerror: ${error.message}`);
  });
  return problems;
}

test.describe("a browser set to German", () => {
  test("shows the departure as a German clock, with English words around it", async ({ page }) => {
    const problems = watchProblems(page);

    await openPlanner(page, "/", "21.10.2026");

    const date = page.getByRole("group", { name: "Date" });
    await expect(date.getByRole("spinbutton")).toHaveText(["21", "10", "2026"]);
    const time = page.getByRole("group", { name: "Time" });
    await expect(time).toContainText(/17:\d{2}/u);
    await expect(time).not.toContainText(/AM|PM/u);
    // The words React Aria writes itself are English, since the German ones are not shipped; the
    // names of the segments (Tag, Monat, Jahr) come from the browser's own `Intl.DisplayNames`.
    await expect(page.getByRole("button", { name: /^Calendar/u })).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: /^Stunde/u })).toBeVisible();
    expect(problems).toEqual([]);
  });

  test("writes the arrival times of a plan as a German clock", async ({ page }) => {
    const problems = watchProblems(page);

    await openPlanner(page, tripAddress("calm"), "21.10.2026");
    await page.getByRole("button", { name: "Plan routes" }).click();

    const routes = page.getByRole("grid", { name: "Routes" });
    await expect(routes).toBeVisible();
    await expect(routes).toContainText(/\b\d{2}:\d{2}\b/u);
    await expect(routes).not.toContainText(/\b(?:AM|PM)\b/u);
    expect(problems).toEqual([]);
  });
});
