// THROWAWAY PROBE (never merged): R4F-BS, finding R3-15. What a real browser sends to the sheet's
// handle. The fix in BottomSheet.tsx reads `click.detail`: a click that a pointer made has 1 or
// more, a click that Enter or Space made has 0. If an engine said otherwise, a drag would be
// followed by a second cycle, or a keyboard click would be swallowed. The jsdom tests cannot see
// that, because jsdom makes the `detail` itself. The fixed waits are this probe's own: a permanent
// test would wait on state. It runs on a push to a probe/** branch only.
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./support/mock-api";
import { openPlanner } from "./support/planner";

test.use({ locale: "en-US", timezoneId: "America/Denver" });

const HANDLE = "Resize panel";

interface Seen {
  clicks: { detail: number; pointerType: string; label: string }[];
  snaps: string[];
}

/** Opens the planner in the sheet's layout, and records every click and every snap change. */
async function openSheet(page: Page): Promise<{ sheet: Locator; handle: Locator }> {
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    // The desktop projects get the sheet the way a narrow window does.
    await page.setViewportSize({ width: 390, height: 780 });
  }
  await openPlanner(page);
  const sheet = page.getByRole("region", { name: "Trip planner" });
  const handle = sheet.getByRole("button", { name: HANDLE });
  await expect(sheet).toHaveAttribute("data-snap", "half");
  await page.evaluate(() => {
    const seen: Seen = { clicks: [], snaps: [] };
    (window as unknown as { __seen: Seen }).__seen = seen;
    document.addEventListener(
      "click",
      (event) => {
        const button = event.target instanceof Element ? event.target.closest("button") : null;
        seen.clicks.push({
          detail: event.detail,
          pointerType: String((event as PointerEvent).pointerType),
          label: button?.getAttribute("aria-label") ?? "",
        });
      },
      true,
    );
    const section = document.querySelector("section[aria-label='Trip planner']");
    if (section === null) throw new Error("The sheet is not on the page.");
    new MutationObserver(() => {
      seen.snaps.push(section.getAttribute("data-snap") ?? "");
    }).observe(section, { attributes: true, attributeFilter: ["data-snap"] });
  });
  return { sheet, handle };
}

const seenOf = (page: Page): Promise<Seen> =>
  page.evaluate(() => (window as unknown as { __seen: Seen }).__seen);

async function forget(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen = (window as unknown as { __seen: Seen }).__seen;
    seen.clicks.length = 0;
    seen.snaps.length = 0;
  });
}

async function centreOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("The handle has no box.");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The clicks that landed on the handle itself. */
const onHandle = (seen: Seen): Seen["clicks"] => seen.clicks.filter((c) => c.label === HANDLE);

/** One line per observation, so the raw facts are in the log even when every assertion passes. */
function report(name: string, facts: unknown): void {
  console.log(`PROBE ${test.info().project.name} ${name} ${JSON.stringify(facts)}`);
}

test("a mouse click on the handle cycles the sheet once; its click has a pointer behind it", async ({
  page,
}) => {
  const { handle } = await openSheet(page);
  await handle.click();
  await page.waitForTimeout(600);
  const seen = await seenOf(page);
  report("mouse-click", seen);
  expect(onHandle(seen).map((click) => click.detail > 0)).toEqual([true]);
  expect(seen.snaps).toHaveLength(1);
});

test("Enter and Space on the handle each cycle the sheet once; their click has no pointer", async ({
  page,
}) => {
  const { handle } = await openSheet(page);
  await handle.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await page.keyboard.press("Space");
  await page.waitForTimeout(400);
  const seen = await seenOf(page);
  report("keyboard", seen);
  expect(onHandle(seen).map((click) => click.detail)).toEqual([0, 0]);
  expect(seen.snaps).toHaveLength(2);
});

test("a touch tap on the handle cycles the sheet once; its click has a pointer behind it", async ({
  page,
  hasTouch,
}) => {
  test.skip(!hasTouch, "tap() needs a touch screen: the two phone projects have one");
  const { handle } = await openSheet(page);
  await handle.tap();
  await page.waitForTimeout(600);
  const seen = await seenOf(page);
  report("touch-tap", seen);
  expect(onHandle(seen).map((click) => click.detail > 0)).toEqual([true]);
  expect(seen.snaps).toHaveLength(1);
});

test("a press that wanders 3 px is still a tap: the sheet cycles once", async ({ page }) => {
  const { handle } = await openSheet(page);
  const { x, y } = await centreOf(handle);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 3);
  await page.mouse.up();
  await page.waitForTimeout(600);
  const seen = await seenOf(page);
  report("wander-3px", seen);
  expect(onHandle(seen).map((click) => click.detail > 0)).toEqual([true]);
  expect(seen.snaps).toHaveLength(1);
});

test("a slow 60 px drag that ends on the handle is not followed by a second cycle", async ({
  page,
}) => {
  const { sheet, handle } = await openSheet(page);
  const { x, y } = await centreOf(handle);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (const travelled of [10, 20, 30, 40, 50, 60]) {
    await page.mouse.move(x, y - travelled);
    await page.waitForTimeout(30);
  }
  // A finger that rested before it lifted has no velocity (the window is 100 ms).
  await page.waitForTimeout(250);
  await page.mouse.up();
  await page.waitForTimeout(800);
  const dragged = await seenOf(page);
  report("drag-60px", dragged);
  expect(onHandle(dragged).map((click) => click.detail > 0)).toEqual([true]);
  expect(dragged.snaps).toEqual([]);
  await expect(sheet).toHaveAttribute("data-snap", "half");

  // The click that was swallowed cleared the flag: the keyboard cycles at once.
  await forget(page);
  await handle.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  const keyed = await seenOf(page);
  report("drag-60px-then-enter", keyed);
  expect(onHandle(keyed).map((click) => click.detail)).toEqual([0]);
  expect(keyed.snaps).toHaveLength(1);
});

test("after a drag that ends away from the handle, Enter still cycles the sheet", async ({
  page,
}) => {
  const { handle } = await openSheet(page);
  const { x, y } = await centreOf(handle);
  const bottom = (page.viewportSize()?.height ?? 0) - 1;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const steps = 8;
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(x, y + ((bottom - y) * step) / steps);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(250);
  await page.mouse.up();
  await page.waitForTimeout(800);
  const dragged = await seenOf(page);
  report("drag-down-away", { dragged, handleBox: await handle.boundingBox(), releasedAt: bottom });
  // The premise: the button came up away from the handle, so no click reached it. That leaves the
  // flag of the drag armed, and the old code swallowed the next keyboard click with it.
  expect(onHandle(dragged)).toEqual([]);

  await forget(page);
  await handle.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  const keyed = await seenOf(page);
  report("drag-down-away-then-enter", keyed);
  expect(onHandle(keyed).map((click) => click.detail)).toEqual([0]);
  expect(keyed.snaps).toHaveLength(1);
});
