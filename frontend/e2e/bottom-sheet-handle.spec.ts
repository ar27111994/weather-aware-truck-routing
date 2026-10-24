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
//
// The second fact is D-60 (DESIGN.md, BottomSheet): a pointer tap on the handle, touch, mouse or
// pen, moves no focus in any engine, and a drag moves none either. The control that had the focus
// keeps it and gets no blur, and with nothing focused the page body keeps it. Enter, Space and a
// screen reader's activation start with the focus on the handle, and it stays there. The focus is
// read from the events that the page sends, so what the on-screen keyboard does with a blur on a
// phone is not shown here.

test.use({ locale: "en-US", timezoneId: "America/Denver" });

const SHEET = "Trip planner";
const HANDLE = "Resize panel";
/** The place field that comes first in the sheet: a control with a focus that a tap could take. */
const FROM = /^From/u;
/** The sheet is drawn under 1024 px: a desktop project gets the window of a phone. */
const PHONE = { width: 390, height: 780 } as const;
/**
 * How long (ms) a pointer must be still before it lifts for the release to carry no speed: the
 * sheet only counts the last 100 ms of a drag (VELOCITY_WINDOW in sheetGeometry.ts), and a quick
 * release flings the sheet to the next snap point, which is a snap change of its own.
 */
const REST = 150;
/**
 * How long (ms) to wait after a gesture that changes no snap point, before its focus is read.
 * React Aria's press waits 80 ms for the click of a pointer that sends none, and makes the click
 * itself when the wait ends: this is longer than that wait, so the focus is read after it.
 */
const CLICK_WAIT = 300;

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

/** What the page's focus is, and what moved it, since `watchFocus` started. */
interface FocusWatch {
  /** The element that has the focus now: its tag, and its name or id. */
  readonly active: () => Promise<string>;
  /** The focus events so far, in order: `type target > the element the focus leaves or reaches`. */
  readonly events: () => Promise<string[]>;
}

/**
 * Starts recording the focus events of the page: focusin, focusout, focus and blur, on the window
 * in the capture phase. The window is the first stop of each of them, and a listener that is added
 * now runs before any that is added later, so this one sees every event, even one that React
 * Aria's press takes out of the page's sight with stopImmediatePropagation (its `preventFocus`
 * lets the browser move the focus and gives it back, and a listener on the document hears
 * nothing). Events of the window itself are left out: only a move between elements is a move.
 */
async function watchFocus(page: Page): Promise<FocusWatch> {
  const watch = await page.evaluateHandle(() => {
    const events: string[] = [];
    const nameOf = (element: Element): string => {
      const label = element.getAttribute("aria-label");
      if (label !== null) return label;
      const labelledBy = element.getAttribute("aria-labelledby");
      const named =
        labelledBy !== null
          ? labelledBy.split(" ").map((id) => document.getElementById(id)?.textContent ?? "")
          : "labels" in element && element.labels instanceof NodeList
            ? [...element.labels].map((control) => control.textContent ?? "")
            : [];
      return named.join(" ").trim() || element.id;
    };
    const describe = (node: EventTarget | null): string => {
      if (!(node instanceof Element)) return "nothing";
      const tag = node.tagName.toLowerCase();
      const name = nameOf(node);
      return name === "" ? tag : `${tag} "${name}"`;
    };
    for (const type of ["focusin", "focusout", "focus", "blur"]) {
      window.addEventListener(
        type,
        (event) => {
          if (event.target instanceof Element) {
            const goes = describe((event as FocusEvent).relatedTarget);
            events.push(`${type} ${describe(event.target)} > ${goes}`);
          }
        },
        true,
      );
    }
    return { events, active: () => describe(document.activeElement) };
  });
  return {
    active: () => watch.evaluate((recorder) => recorder.active()),
    events: () => watch.evaluate((recorder) => [...recorder.events]),
  };
}

/** D-60: the gesture left the focus where it was, and no element lost or got it on the way. */
async function expectFocusKept(watch: FocusWatch, before: string, gesture: string): Promise<void> {
  expect(
    { focused: await watch.active(), events: await watch.events() },
    `${gesture} moves no focus (D-60): the focus was on ${before}, and no focus event may follow`,
  ).toEqual({ focused: before, events: [] });
}

type Watched = FocusWatch & { readonly before: string };

/** Puts the focus on the first place field, the control that a tap on the handle must not blur. */
async function focusFromField(page: Page): Promise<Watched> {
  await page.getByRole("combobox", { name: FROM }).focus();
  const watch = await watchFocus(page);
  const before = await watch.active();
  expect(before, "the place field has the focus before the gesture").toMatch(/^input "From/u);
  return { ...watch, before };
}

/** Takes the focus off every element, so that the page body has it. */
async function focusNothing(page: Page): Promise<Watched> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  const watch = await watchFocus(page);
  const before = await watch.active();
  expect(before, "the page body has the focus before the gesture").toBe("body");
  return { ...watch, before };
}

/**
 * A mouse drag that comes down on the handle, goes up the screen or down to its bottom edge, rests
 * and lets go: on the handle, which the sheet followed up, or on the page, below the sheet.
 */
async function dragHandle(
  page: Page,
  { sheet, handle }: Pick<OpenSheet, "sheet" | "handle">,
  endsOn: "the handle" | "the page",
): Promise<void> {
  const { x, y } = await centreOf(handle);
  await page.mouse.move(x, y);
  await page.mouse.down();
  if (endsOn === "the handle") {
    await page.mouse.move(x, y - 60, { steps: 6 });
  } else {
    await page.mouse.move(x, (page.viewportSize()?.height ?? 0) - 1, { steps: 8 });
  }
  await expect(sheet, "the sheet follows the pointer").toHaveAttribute("data-dragging", "true");
  await restFor(page, REST);
  await page.mouse.up();
  await expect(sheet).not.toHaveAttribute("data-dragging");
  await restFor(page, CLICK_WAIT);
}

test.describe("a touch tap on the handle", () => {
  // The block gives every project a touch screen, so a tap can be made on the desktop engines too.
  test.use({ hasTouch: true });

  test("cycles the sheet exactly once", async ({ page }) => {
    const { handle, changes } = await openSheet(page);

    await handle.tap();

    await expectOneCycle(page, changes);
  });

  test("leaves the focus on the control that had it, with no blur (D-60)", async ({ page }) => {
    const { handle, changes } = await openSheet(page);
    const { before, ...watch } = await focusFromField(page);

    await handle.tap();

    await expectOneCycle(page, changes);
    await expectFocusKept(watch, before, "a tap on the handle");
  });

  test("with nothing focused, leaves the focus on the page body and gives the handle none (D-60)", async ({
    page,
  }) => {
    const { handle, changes } = await openSheet(page);
    const { before, ...watch } = await focusNothing(page);

    await handle.tap();

    await expectOneCycle(page, changes);
    await expectFocusKept(watch, before, "a tap on the handle");
  });
});

test.describe("a mouse and the keyboard on the handle", () => {
  test("a mouse click cycles the sheet exactly once", async ({ page }) => {
    const { handle, changes } = await openSheet(page);

    await handle.click();

    await expectOneCycle(page, changes);
  });

  test("a mouse click leaves the focus on the control that had it, with no blur (D-60)", async ({
    page,
  }) => {
    const { handle, changes } = await openSheet(page);
    const { before, ...watch } = await focusFromField(page);

    await handle.click();

    await expectOneCycle(page, changes);
    await expectFocusKept(watch, before, "a mouse click on the handle");
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

  test("a drag that ends on the handle leaves the focus on the control that had it (D-60)", async ({
    page,
  }) => {
    const open = await openSheet(page);
    const { before, ...watch } = await focusFromField(page);

    await dragHandle(page, open, "the handle");

    await expectFocusKept(watch, before, "a drag that ends on the handle");
  });

  test("a drag that ends away from the handle leaves the focus on the control that had it (D-60)", async ({
    page,
  }) => {
    const open = await openSheet(page);
    const { before, ...watch } = await focusFromField(page);

    await dragHandle(page, open, "the page");

    await expectFocusKept(watch, before, "a drag that ends away from the handle");
  });

  test("Enter on the handle, reached by Shift+Tab, cycles the sheet with the focus staying on it", async ({
    page,
  }) => {
    const { handle, changes } = await openSheet(page);
    await page.getByRole("combobox", { name: FROM }).focus();
    for (let presses = 0; presses < 8; presses += 1) {
      if (await handle.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press("Shift+Tab");
    }
    await expect(handle, "Shift+Tab from the first field reaches the handle").toBeFocused();
    const watch = await watchFocus(page);
    const before = await watch.active();
    expect(before).toBe(`button "${HANDLE}"`);

    await page.keyboard.press("Enter");

    await expectOneCycle(page, changes);
    await expectFocusKept(watch, before, "Enter on the handle");
  });
});
