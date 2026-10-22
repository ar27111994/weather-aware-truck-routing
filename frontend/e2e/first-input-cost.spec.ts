import type { Browser, CDPSession, Page } from "@playwright/test";

import { measureInitialJs } from "./support/initial-js.ts";
import { expect, test } from "./support/mock-api.ts";
import { tripAddress, wakePlanner } from "./support/planner.ts";

// D-46 section 3.5 (d), report only: what the planner's first input costs. Nothing here fails a build;
// the numbers go to the CI log and to the test report, and from there to the PR body and the ADR.
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
  await page.getByRole("combobox", { name: /^From/u }).click();
  const alive = await page.waitForFunction(
    () => (/\d/u.test(document.querySelector("form fieldset")?.textContent ?? "") ? performance.now() : false),
    undefined,
    { timeout: 120_000 },
  );
  return Number(await alive.jsonValue()) - Number(await page.evaluate(() => Reflect.get(window, "firstPointerDown")));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
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

    const report = JSON.stringify({ gzipBytes: bytes, inputToInteractiveMs: milliseconds }, null, 2);
    await test.info().attach("first-input-cost", { body: report, contentType: "application/json" });
    console.log(`first-input-cost ${report}`);

    expect(bytes["onInput"]).toBeGreaterThan(0);
  });
});
