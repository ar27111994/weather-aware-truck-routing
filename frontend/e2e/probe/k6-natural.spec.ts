import type { Page } from "@playwright/test";

import { expect, test } from "../support/mock-api";
import { NOW, REQUIRED, RECORDER, dumpTrace, holdCode, type Step } from "./recorder";

// THROWAWAY PROBE (card R4F-E3, never merged). The K6 test of early-input.spec.ts, step for step,
// with the recorder inside the page: the click as Playwright makes it, as fast as it goes.
test.use({ locale: "en-US", timezoneId: "America/Denver" });

const hydrated = (page: Page): Promise<void> =>
  expect(page.getByRole("group", { name: "Date" })).toContainText("10/21/2026");

test("K6 natural: tapping Plan routes before hydration, checked once after it", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  const steps: Step[] = [];
  const begin = Date.now();
  const note = (step: string): void => {
    steps.push({ at: Date.now() - begin, step });
  };
  let ok = false;
  await page.addInitScript({ content: RECORDER });
  const held = await holdCode(page);
  await page.clock.setFixedTime(NOW);
  try {
    await page.goto("/");
    note("loaded");
    const history = await page.evaluate(() => window.history.length);

    await page.getByRole("button", { name: "Plan routes" }).click();
    note("click returned");
    await expect.poll(held.requested).toBe(true);
    note("code requested");
    expect(new URL(page.url()).search).toBe("");
    expect(await page.evaluate(() => window.history.length)).toBe(history);

    await held.release();
    note("released");
    await hydrated(page);
    note("hydrated");

    await expect(page.getByText(REQUIRED)).toHaveCount(1);
    note("message counted once");
    expect(problems).toEqual([]);
    ok = true;
  } finally {
    await dumpTrace(page, "natural", ok, steps, problems);
  }
});
