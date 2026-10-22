import type { Page } from "@playwright/test";

import {
  INITIAL_JS_BUDGET_BYTES,
  INPUT_JS_BUDGET_BYTES,
  describeInitialJs,
  summaryLine,
} from "../scripts/perf/initial-js.ts";

import { measureInitialJs } from "./support/initial-js.ts";
import { expect, test } from "./support/mock-api.ts";
import { NOW, wakePlanner } from "./support/planner.ts";

/** The planner is alive when the departure date has a value: only the browser's clock gives it one. */
async function plannerIsAlive(page: Page): Promise<void> {
  await expect(page.getByRole("group", { name: "Date" })).toContainText(/\d/u);
}

/** Gives the prerendered page one input, the way a visitor does, and waits for the planner. */
async function oneInput(page: Page): Promise<void> {
  await wakePlanner(page);
  await plannerIsAlive(page);
}

// N1 (REQUIREMENTS.md, D-45): a first visit to a page downloads at most 180 kB of gzipped
// JavaScript, MapLibre's lazy chunk aside. The budget is measured in the browser, on the production
// build: every script file requested from the start of the navigation until 2 s after the load
// event, with no input. A chunk the page imports lazily still counts when it is requested in that
// window. `@budget` keeps the checks in the chromium project (playwright.config.ts): one engine is
// enough, because the bytes served do not depend on the browser. Each run prints the total, so the
// CI log shows how much room is left.
test.describe("the initial JavaScript budget (N1) @budget", () => {
  for (const [path, what] of [
    ["/", "the planner"],
    ["/methodology", "the methodology page"],
  ] as const) {
    test(`${what} (${path}) downloads at most 180 kB of gzipped JavaScript`, async ({ page }) => {
      const measured = await measureInitialJs(page, path);
      const report = describeInitialJs(path, measured);
      await test.info().attach("initial-javascript", { body: report, contentType: "text/plain" });
      console.log(summaryLine(path, measured));

      expect(measured.gzipBytes, report).toBeLessThanOrEqual(INITIAL_JS_BUDGET_BYTES);
    });
  }

  // D-46: the planner's code is a separate download that starts at the visitor's first input. The
  // split may not add bytes: the first visit plus what one input loads (no plan asked for) is at
  // most what the planner cost as one download.
  test("the planner after one input downloads no more than it did as one download", async ({
    page,
  }) => {
    await page.clock.setFixedTime(NOW);
    const measured = await measureInitialJs(page, "/", oneInput);
    const report = describeInitialJs("/ after one input", measured, INPUT_JS_BUDGET_BYTES);
    await test.info().attach("javascript-after-one-input", {
      body: report,
      contentType: "text/plain",
    });
    console.log(summaryLine("/ after one input", measured, INPUT_JS_BUDGET_BYTES));

    expect(measured.gzipBytes, report).toBeLessThanOrEqual(INPUT_JS_BUDGET_BYTES);
  });

  // A client-rendered page (`/design`, an address that does not exist) is served from the SPA
  // fallback, so every visitor to one downloads the shell the planner and the methodology page
  // share. The shell is not allowed to cost more than the budget either.
  test("a page that is not prerendered (the SPA fallback) downloads at most 180 kB", async ({
    page,
  }) => {
    const measured = await measureInitialJs(page, "/this-page-does-not-exist");
    const report = describeInitialJs("the SPA fallback", measured);
    await test.info().attach("initial-javascript", { body: report, contentType: "text/plain" });
    console.log(summaryLine("the SPA fallback", measured));

    expect(measured.gzipBytes, report).toBeLessThanOrEqual(INITIAL_JS_BUDGET_BYTES);
  });
});
