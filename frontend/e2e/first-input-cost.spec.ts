import type { Browser, CDPSession, Page } from "@playwright/test";

import { INITIAL_JS_BUDGET_BYTES } from "../scripts/perf/initial-js.ts";

import { measureInitialJs } from "./support/initial-js.ts";
import { expect, test } from "./support/mock-api.ts";
import { openPlanner, tripAddress, wakePlanner } from "./support/planner.ts";

// D-46 section 3.5 (d), report only: what the planner's first input costs. Nothing here fails a build
// because of a slow number; the numbers go to the CI log and to the test report, and from there to the
// PR body and the ADR. The checks that do fail are about the harness itself: a measurement that cannot
// see the planner come alive, or a throttle that does not bite, would report a number that means nothing.
// `@budget` keeps it in the chromium project: the bytes and the main-thread work are measured in one
// engine, on the CI machine.
//
// "Input to interactive" is the time from the visitor's first pointerdown on Origin until the planner
// has taken the page over (the departure date has a value: only the browser's clock gives it one).
// It is measured twice: with nothing throttled, and with Lighthouse's mobile profile (150 ms round
// trip, 1,638.4 kbit/s down, 675 kbit/s up, the CPU four times slower). Each is the median of five.
test.use({ locale: "en-US", timezoneId: "America/Denver" });
test.setTimeout(600_000);

const RUNS = 5;

/** The departure date's month segment: `mm` in the prerendered page, a number once the planner is alive. */
const MONTH = 'form [data-type="month"]';

const HEADLINE = /^Take Route [A-C]\.$/u;

interface Profile {
  readonly name: string;
  /** `null` is the machine as it is. */
  readonly throttle: { latencyMs: number; downKbps: number; upKbps: number; cpu: number } | null;
}

const PROFILES: readonly Profile[] = [
  { name: "unthrottled", throttle: null },
  {
    name: "lighthouse-mobile",
    throttle: { latencyMs: 150, downKbps: 1638.4, upKbps: 675, cpu: 4 },
  },
];

/** A page with no cache, and the profile's network and processor limits. */
async function limitedPage(browser: Browser, profile: Profile): Promise<Page> {
  const context = await browser.newContext({ locale: "en-US", timezoneId: "America/Denver" });
  const page = await context.newPage();
  const cdp: CDPSession = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  if (profile.throttle !== null) {
    const { latencyMs, downKbps, upKbps, cpu } = profile.throttle;
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: latencyMs,
      downloadThroughput: (downKbps * 1024) / 8,
      uploadThroughput: (upKbps * 1024) / 8,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  }
  return page;
}

/** Milliseconds from the first pointerdown on Origin to the planner being alive, in the page's own time. */
async function inputToInteractive(page: Page): Promise<number> {
  await page.addInitScript(() => {
    document.addEventListener(
      "pointerdown",
      () => {
        Reflect.set(window, "firstPointerDown", performance.now());
      },
      { capture: true, once: true },
    );
  });
  await page.goto("/", { waitUntil: "load" });
  // The measurement means nothing if the prerendered page already looks alive: then the time below
  // would be how long the check takes, not how long the planner does.
  await expect(page.locator(MONTH)).not.toContainText(/\d/u);
  await page.getByRole("combobox", { name: /^From/u }).click();
  const alive = await page.waitForFunction(
    (selector) =>
      /\d/u.test(document.querySelector(selector)?.textContent ?? "") ? performance.now() : false,
    MONTH,
    { timeout: 120_000 },
  );
  const startedAt = await page.evaluate((): number =>
    Number(Reflect.get(window, "firstPointerDown")),
  );
  return Number(await alive.jsonValue()) - startedAt;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

/**
 * The least time `bytes` can take to arrive over the profile's link: one round trip plus the
 * transfer at its bandwidth (the bytes are gzipped sizes, so what the server really sends is no
 * less). Nothing is limited without a throttle, so the floor is zero.
 */
function fastestPossibleMs(profile: Profile, bytes: number): number {
  if (profile.throttle === null) return 0;
  const bytesPerSecond = (profile.throttle.downKbps * 1024) / 8;
  return profile.throttle.latencyMs + (bytes / bytesPerSecond) * 1000;
}

test.describe("what the planner's first input costs (report only) @budget", () => {
  test("bytes and input-to-interactive time", async ({ browser }) => {
    const bytes: Record<string, number> = {};
    for (const [name, path, afterLoad] of [
      ["initial", "/", undefined],
      [
        "afterOneInput",
        "/",
        async (page: Page) => {
          await wakePlanner(page);
          await expect(page.getByRole("group", { name: "Date" })).toContainText(/\d/u);
        },
      ],
      [
        "sharedLink",
        tripAddress("calm"),
        async (page: Page) => {
          await expect(page.getByRole("group", { name: "Date" })).toContainText(/\d/u);
        },
      ],
    ] as const) {
      const context = await browser.newContext({ locale: "en-US", timezoneId: "America/Denver" });
      const page = await context.newPage();
      bytes[name] = (await measureInitialJs(page, path, afterLoad)).gzipBytes;
      await context.close();
    }
    bytes["onInput"] = (bytes["afterOneInput"] ?? 0) - (bytes["initial"] ?? 0);

    const milliseconds: Record<string, { runs: number[]; median: number }> = {};
    for (const profile of PROFILES) {
      const runs: number[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const page = await limitedPage(browser, profile);
        runs.push(Math.round(await inputToInteractive(page)));
        await page.context().close();
      }
      milliseconds[profile.name] = { runs, median: median(runs) };
    }

    const report = JSON.stringify(
      { gzipBytes: bytes, inputToInteractiveMs: milliseconds },
      null,
      2,
    );
    await test.info().attach("first-input-cost", { body: report, contentType: "application/json" });
    console.log(`first-input-cost ${report}`);

    expect(bytes["onInput"]).toBeGreaterThan(0);
    // Harness check: the planner's code cannot reach the page faster than the profile's link carries
    // it, so a median under one round trip plus the transfer time of what the input loads means the
    // measurement did not wait for the planner, or the limit never took effect.
    for (const profile of PROFILES) {
      expect(milliseconds[profile.name]?.median ?? 0, profile.name).toBeGreaterThan(
        fastestPossibleMs(profile, bytes["onInput"] ?? 0),
      );
    }
  });

  // D-46 3.5 (d): the size of `/?plan=`, a plan opened from its address. Everything the page
  // downloads until the recommendation is on screen: the planner, and the results code a plan needs.
  test("the size of a plan opened from its address", async ({ page }) => {
    // The second visit downloads every file again: a script served from the cache would measure nothing.
    const cdp: CDPSession = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await openPlanner(page, tripAddress("calm"));
    await page.getByRole("button", { name: "Plan routes" }).click();
    await expect(page).toHaveURL(/[?&]plan=pln_/u);
    const address = page.url();

    const measured = await measureInitialJs(page, address, async (opened) => {
      await expect(opened.getByText(HEADLINE)).toBeVisible();
    });

    const report = JSON.stringify({ gzipBytes: { planLink: measured.gzipBytes } }, null, 2);
    await test.info().attach("plan-link-cost", { body: report, contentType: "application/json" });
    console.log(`plan-link-cost ${report}`);

    // The planner alone is already past the first-visit budget, so a plan has to be bigger than it.
    expect(measured.gzipBytes).toBeGreaterThan(INITIAL_JS_BUDGET_BYTES);
  });
});
