import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./support/mock-api";
import { openPlanner } from "./support/planner";

// What a real engine does when a person uses the BottomSheet's handle: a touch tap, a mouse click,
// a short wander, a drag and the keyboard. The unit tests make their events themselves, so they
// cannot show what an engine really sends. One fact decided this spec (BS-F1): React Aria's
// useMove cancels the handle's pointerdown, and WebKit then sends a touch tap no mousedown, mouseup
// or click at all, while Chromium and Firefox still send the click. A tap must cycle the sheet
// once in every engine, so it is read from the press itself and the click that follows a press is
// not a second tap.

test.use({ locale: "en-US", timezoneId: "America/Denver" });

const SHEET = "Trip planner";
const HANDLE = "Resize panel";
/** The sheet is drawn under 1024 px: a desktop project gets the window of a phone. */
const PHONE = { width: 390, height: 780 } as const;
/**
 * How long (ms) a pointer must be still before it lifts for the release to carry no speed: the
 * sheet only counts the last 100 ms of a drag (VELOCITY_WINDOW in sheetGeometry.ts), and a quick
 * release flings the sheet to the next snap point, which is a snap change of its own.
 */
const REST = 150;

interface OpenSheet {
  readonly sheet: Locator;
  readonly handle: Locator;
  /** Every snap point the sheet took since it was opened, one entry per change of `data-snap`. */
  readonly changes: () => Promise<string[]>;
}

/** Opens the planner where the sheet is drawn, and starts counting the sheet's snap changes. */
async function openSheet(page: Page): Promise<OpenSheet> {
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    await page.setViewportSize(PHONE);
  }
  await openPlanner(page);
  const sheet = page.getByRole("region", { name: SHEET });
  const handle = sheet.getByRole("button", { name: HANDLE });
  await expect(sheet).toHaveAttribute("data-snap", "half");
  const taken = await page.evaluateHandle(() => {
    const snaps: string[] = [];
    const section = document.querySelector("section[aria-label='Trip planner']");
    if (section === null) throw new Error("The sheet is not on the page.");
    new MutationObserver((records) => {
      snaps.push(...records.map(() => section.getAttribute("data-snap") ?? ""));
    }).observe(section, { attributes: true, attributeFilter: ["data-snap"] });
    return snaps;
  });
  return { sheet, handle, changes: () => taken.jsonValue() };
}

/** Two animation frames: every event that a gesture sends has reached the page by then. */
async function afterFrames(page: Page): Promise<void> {
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
}

/** The gesture took the sheet one step from half (up, to full), and nothing took it a second. */
async function expectOneCycle(page: Page, changes: OpenSheet["changes"]): Promise<void> {
  await expect
    .poll(async () => (await changes()).length, {
      message: "the number of times the sheet changed its snap point after the gesture",
    })
    .toBe(1);
  await afterFrames(page);
  const taken = await changes();
  expect(taken, `the sheet changed snap point ${String(taken.length)} times`).toEqual(["full"]);
}

async function centreOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("The handle has no box.");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Waits until the page's own clock has run `ms` from this call: the pointer has rested. */
async function restFor(page: Page, ms: number): Promise<void> {
  const since = await page.evaluate(() => performance.now());
  await expect
    .poll(() => page.evaluate(() => performance.now()), { message: "the pointer rests" })
    .toBeGreaterThan(since + ms);
}

test.describe("a touch tap on the handle", () => {
  // The block gives every project a touch screen, so a tap can be made on the desktop engines too.
  test.use({ hasTouch: true });

  test("cycles the sheet exactly once", async ({ page }) => {
    const { handle, changes } = await openSheet(page);

    await handle.tap();

    await expectOneCycle(page, changes);
  });
});

test.describe("a mouse and the keyboard on the handle", () => {
  test("a mouse click cycles the sheet exactly once", async ({ page }) => {
    const { handle, changes } = await openSheet(page);

    await handle.click();

    await expectOneCycle(page, changes);
  });

  test("a press that wanders 3 px is still a tap: the sheet cycles exactly once", async ({
    page,
  }) => {
    const { handle, changes } = await openSheet(page);
    const { x, y } = await centreOf(handle);

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 3);
    await page.mouse.up();

    await expectOneCycle(page, changes);
  });

  test("a drag that ends on the handle moves the sheet and does not also cycle it", async ({
    page,
  }) => {
    const { sheet, handle, changes } = await openSheet(page);
    const { x, y } = await centreOf(handle);

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 60, { steps: 6 });
    await expect(sheet, "the sheet follows the pointer").toHaveAttribute("data-dragging", "true");
    await restFor(page, REST);
    await page.mouse.up();
    await expect(sheet).not.toHaveAttribute("data-dragging");
    await afterFrames(page);

    // The pointer came up on the handle, so the browser sent a click after it. It ends the drag.
    expect(await changes(), "a drag that settles where it began changes no snap point").toEqual([]);
    // The next press of Enter is the end of no drag, and still cycles the sheet.
    await handle.focus();
    await page.keyboard.press("Enter");
    await expect.poll(changes).toEqual(["full"]);
  });

  test("after a drag that ends away from the handle, Enter still cycles the sheet", async ({
    page,
  }) => {
    const { sheet, handle, changes } = await openSheet(page);
    const { x, y } = await centreOf(handle);
    const bottom = (page.viewportSize()?.height ?? 0) - 1;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, bottom, { steps: 8 });
    await restFor(page, REST);
    await page.mouse.up();
    await expect(sheet).toHaveAttribute("data-snap", "peek");
    const dragged = await changes();
    expect(dragged, "the drag settled the sheet at peek, once").toEqual(["peek"]);

    await handle.focus();
    await page.keyboard.press("Enter");
    await expect.poll(changes).toEqual([...dragged, "half"]);
    await afterFrames(page);
    expect(await changes()).toEqual([...dragged, "half"]);
  });
});
