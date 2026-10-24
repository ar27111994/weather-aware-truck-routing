import type { Page } from "@playwright/test";

import {
  DESIGN_JS_BUDGET_BYTES,
  INITIAL_JS_BUDGET_BYTES,
  INITIAL_JS_FILE_BUDGETS,
  INPUT_JS_BUDGET_BYTES,
  capProblem,
  describeInitialJs,
  fileBudgetProblem,
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
//
// P1 (D-48) adds the number of script files to the same measurement. D-35 made each demo of the
// style guide a lazy entry point, and without `demoBlindChunks` (vite.config.ts) Rollup cuts the
// shared code of every page along the 40 of them: `/` asked for 42 files where the same app with
// the demos behind one chunk asks for 22. The bytes alone cannot see that, because the room P1
// gave back is about as big as the tax was, so each page also has a budget of files
// (`INITIAL_JS_FILE_BUDGETS`): the count of the same app without the tax.
test.describe("the initial JavaScript budget (N1) @budget", () => {
  for (const [path, what, files] of [
    ["/", "the planner", INITIAL_JS_FILE_BUDGETS.planner],
    ["/methodology", "the methodology page", INITIAL_JS_FILE_BUDGETS.methodology],
  ] as const) {
    test(`${what} (${path}) downloads at most 180 kB of gzipped JavaScript, in at most ${String(files)} files`, async ({
      page,
    }) => {
      const measured = await measureInitialJs(page, path);
      const report = describeInitialJs(path, measured);
      await test.info().attach("initial-javascript", { body: report, contentType: "text/plain" });
      console.log(summaryLine(path, measured));

      expect(measured.gzipBytes, report).toBeLessThanOrEqual(INITIAL_JS_BUDGET_BYTES);
      expect(fileBudgetProblem(path, measured, files), report).toBeNull();
    });
  }

  // D-46 3.5(c), as D-49 words it: the planner's code is a separate download that starts at the
  // visitor's first input. On the same base the split may add only the bytes of the mechanism that
  // D-46 3.1, 3.2, 3.3 and D-47 require and of fixes for defects the split itself causes, every
  // byte itemized. So the first visit plus what one input loads (no plan asked for) has a cap that
  // is exactly the measured total (INPUT_JS_BUDGET_BYTES says where the number comes from), and it
  // is a ratchet: the check fails when the total is over the cap and when it is under it, so a
  // change that lowers the total lowers the cap in the same change. The cap is exact, so only the
  // Node that frontend/.nvmrc pins can judge it (Q3, D-51 item 5): on any other Node `capProblem`
  // says that it cannot judge, names no number to set the cap to, and the check fails with that
  // message. CI installs the pinned Node, so CI is the authority.
  test("the planner after one input downloads exactly what its cap allows", async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    const measured = await measureInitialJs(page, "/", oneInput);
    const report = describeInitialJs("/ after one input", measured, INPUT_JS_BUDGET_BYTES);
    await test.info().attach("javascript-after-one-input", {
      body: report,
      contentType: "text/plain",
    });
    console.log(summaryLine("/ after one input", measured, INPUT_JS_BUDGET_BYTES));

    expect(capProblem(measured.gzipBytes), report).toBeNull();
  });

  // A client-rendered page (`/design`, an address that does not exist) is served from the SPA
  // fallback, so every visitor to one downloads the shell the planner and the methodology page
  // share. The shell is not allowed to cost more than the budget either.
  test(`a page that is not prerendered (the SPA fallback) downloads at most 180 kB, in at most ${String(INITIAL_JS_FILE_BUDGETS.fallback)} files`, async ({
    page,
  }) => {
    const measured = await measureInitialJs(page, "/this-page-does-not-exist");
    const report = describeInitialJs("the SPA fallback", measured);
    await test.info().attach("initial-javascript", { body: report, contentType: "text/plain" });
    console.log(summaryLine("the SPA fallback", measured));

    expect(measured.gzipBytes, report).toBeLessThanOrEqual(INITIAL_JS_BUDGET_BYTES);
    expect(
      fileBudgetProblem("the SPA fallback", measured, INITIAL_JS_FILE_BUDGETS.fallback),
      report,
    ).toBeNull();
  });
});

// R3-12: the style guide (`/design`) is in neither list above, and nothing held its size. D-35 made
// each of its 40 demos a lazy chunk of its own: a page that asks for one section
// (`/design?section=TextField`) downloads the shell, the route and that section's chunk, and the page
// of every section downloads all 40 demos besides. `DESIGN_JS_BUDGET_BYTES` holds both at what CI
// measured, rounded up to the next 1,000 B (it says where the numbers come from), so a section that
// pulls in more shared code, or a demo that grows, fails here instead of going unseen. These are
// budgets, not ratchets: a total under the budget is fine. They measure like the checks above, a
// first visit with no input, MapLibre's chunks aside, and stay in the chromium project for the same
// reason.
test.describe("the style guide's JavaScript budget (R3-12) @budget", () => {
  for (const [path, what, budget] of [
    [
      "/design?section=TextField",
      "a page of one section of the style guide",
      DESIGN_JS_BUDGET_BYTES.section,
    ],
    ["/design", "the page of every section of the style guide", DESIGN_JS_BUDGET_BYTES.all],
  ] as const) {
    test(`${what} (${path}) downloads at most ${budget.toLocaleString("en-US")} B of gzipped JavaScript`, async ({
      page,
    }) => {
      const measured = await measureInitialJs(page, path);
      const report = describeInitialJs(path, measured, budget);
      await test.info().attach("initial-javascript", { body: report, contentType: "text/plain" });
      console.log(summaryLine(path, measured, budget));

      expect(measured.gzipBytes, report).toBeLessThanOrEqual(budget);
    });
  }
});
