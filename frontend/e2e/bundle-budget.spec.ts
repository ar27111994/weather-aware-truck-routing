import {
  INITIAL_JS_BUDGET_BYTES,
  describeInitialJs,
  summaryLine,
} from "../scripts/perf/initial-js.ts";

import { measureInitialJs } from "./support/initial-js.ts";
import { expect, test } from "./support/mock-api.ts";

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
