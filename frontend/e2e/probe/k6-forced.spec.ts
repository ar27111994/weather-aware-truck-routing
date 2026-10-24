import type { Page, Route } from "@playwright/test";

import { expect, test } from "../support/mock-api";
import { NOW, REQUIRED, RECORDER, dumpTrace, holdCode, type Step } from "./recorder";

// THROWAWAY PROBE (card R4F-E3, never merged). The worst case of K6, made on purpose: the pointer
// goes down on Plan routes, and only then do the stylesheets that the first input asked for arrive
// (they are held back with page.route until the pointer is down, released, and drawn before the
// pointer goes up). A page whose styles are all there at the first paint must keep the button under
// the pointer; a page whose styles come with the planner's code moves it, and the click is lost.
test.use({ locale: "en-US", timezoneId: "America/Denver" });

const hydrated = (page: Page): Promise<void> =>
  expect(page.getByRole("group", { name: "Date" })).toContainText("10/21/2026");

const STYLESHEET = /\.css(?:\?.*)?$/u;

test("K6 forced: the planner's stylesheets arrive between pointer-down and pointer-up", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  const steps: Step[] = [];
  const begin = Date.now();
  const note = (step: string): void => {
    steps.push({ at: Date.now() - begin, step });
  };
  let ok = false;
  await page.addInitScript({ content: RECORDER });
  const held = await holdCode(page);
  const sheets: Route[] = [];
  let holding = false;
  await page.route(STYLESHEET, (route) => {
    if (holding) sheets.push(route);
    else void route.continue();
  });
  await page.clock.setFixedTime(NOW);
  try {
    await page.goto("/");
    note("loaded");
    const button = page.getByRole("button", { name: "Plan routes" });
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    if (box === null) throw new Error("Plan routes has no box");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    // The first input: the pointer moves over the panel, and the page asks for the planner's code
    // and the stylesheets that come with it. The stylesheets are held.
    holding = true;
    await page.mouse.move(x, y);
    await expect.poll(() => sheets.length).toBeGreaterThan(0);
    note(`the page asked for ${String(sheets.length)} stylesheet(s)`);
    await page.mouse.down();
    note("pointer down");
    holding = false;
    for (const route of sheets.splice(0)) await route.continue();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet]")).every(
        (link) => link.sheet !== null,
      ),
    );
    // Two frames, so that the new styles have been laid out before the pointer goes up.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              resolve();
            });
          });
        }),
    );
    note("stylesheets in");
    await page.mouse.up();
    note("pointer up");
    await expect.poll(held.requested).toBe(true);
    expect(new URL(page.url()).search).toBe("");

    await held.release();
    note("released");
    await hydrated(page);
    note("hydrated");
    await expect(page.getByText(REQUIRED)).toHaveCount(1);
    note("message counted once");
    expect(problems).toEqual([]);
    ok = true;
  } finally {
    await dumpTrace(page, "forced", ok, steps, problems);
  }
});
