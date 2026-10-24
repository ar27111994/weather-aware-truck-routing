// THROWAWAY PROBE (never merged): R4F-BS, the touch tap on the sheet handle. On the iPhone 14 project
// `handle.tap()` sent no click at all, with and without the fix of R3-15. Two causes are open:
//   (a) a product defect: the handle cancels the touch's default action (React Aria's useMove calls
//       preventDefault on pointerdown; the handle's CSS has `touch-action: none`), so WebKit makes
//       no click from the tap;
//   (b) a harness limit: Playwright's tap on this WebKit build makes no click on any element.
// So the same tap goes to a plain button outside the sheet (the control), to the sheet's handle, to a
// real header control, and to four injected buttons that isolate the two candidate causes.
// Every event is recorded on window in the capture phase; `defaultPrevented` is read after the
// event has been handled. It runs on a push to a probe/** branch only.
import type { Page } from "@playwright/test";

import { test } from "./support/mock-api";
import { openPlanner } from "./support/planner";

test.use({ locale: "en-US", timezoneId: "America/Denver", hasTouch: true });

const EVENTS = [
  "touchstart",
  "touchend",
  "touchcancel",
  "pointerdown",
  "pointerup",
  "pointercancel",
  "mousedown",
  "mouseup",
  "click",
];

type Entry = [
  type: string,
  target: string,
  pointerType: string,
  detail: number,
  defaultPrevented: boolean,
];

async function record(page: Page): Promise<void> {
  await page.evaluate((types: string[]) => {
    const log: Entry[] = [];
    (window as unknown as { __log: Entry[] }).__log = log;
    const nameOf = (node: EventTarget | null): string => {
      if (!(node instanceof Element)) return "?";
      const named = node.closest("button, a, label, input, section") ?? node;
      return named.id || named.getAttribute("aria-label") || named.tagName.toLowerCase();
    };
    for (const type of types) {
      window.addEventListener(
        type,
        (event) => {
          const entry: Entry = [
            type,
            nameOf(event.target),
            String((event as PointerEvent).pointerType),
            (event as UIEvent).detail,
            false,
          ];
          log.push(entry);
          // Read once every listener has run: a listener that cancels the event shows here.
          setTimeout(() => {
            entry[4] = event.defaultPrevented;
          }, 0);
        },
        true,
      );
    }
  }, EVENTS);
}

/** Four buttons that do nothing, fixed at the top left: they isolate what a tap needs. */
async function addControls(page: Page): Promise<void> {
  await page.evaluate(() => {
    const make = (
      id: string,
      top: number,
      touchActionNone: boolean,
      cancelPointerDown: boolean,
    ) => {
      const button = document.createElement("button");
      button.id = id;
      button.type = "button";
      button.textContent = id;
      button.setAttribute(
        "style",
        `position:fixed;left:8px;top:${String(top)}px;width:220px;height:44px;z-index:99999;` +
          (touchActionNone ? "touch-action:none;" : ""),
      );
      if (cancelPointerDown) {
        button.addEventListener("pointerdown", (event) => {
          event.preventDefault();
        });
      }
      document.body.append(button);
    };
    make("probe-plain", 8, false, false);
    make("probe-touch-action-none", 60, true, false);
    make("probe-cancels-pointerdown", 112, false, true);
    make("probe-cancels-pointerdown-and-touch-action-none", 164, true, true);
  });
}

async function tapAndReport(page: Page, name: string, tap: () => Promise<void>): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __log: Entry[] }).__log.length = 0;
  });
  let outcome = "tapped";
  try {
    await tap();
  } catch (error) {
    outcome = `TAP FAILED: ${String(error).split("\n")[0] ?? ""}`;
  }
  await page.waitForTimeout(800);
  const log = await page.evaluate(() => (window as unknown as { __log: Entry[] }).__log);
  console.log(`PROBE ${test.info().project.name} ${name} | ${outcome} | ${JSON.stringify(log)}`);
}

test("a tap on the planner page: a plain button, the sheet handle, a header control", async ({
  page,
}) => {
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    // The desktop project gets the sheet the way a narrow window does.
    await page.setViewportSize({ width: 390, height: 780 });
  }
  await openPlanner(page);
  await record(page);
  await addControls(page);
  const handle = page
    .getByRole("region", { name: "Trip planner" })
    .getByRole("button", { name: "Resize panel" });

  await tapAndReport(page, "page plain-button-outside-the-sheet", () =>
    page.locator("#probe-plain").tap({ timeout: 5000 }),
  );
  await tapAndReport(page, "page sheet-handle", () => handle.tap({ timeout: 5000 }));
  await tapAndReport(page, "page header-theme-radio-label", () =>
    page.locator("header label").first().tap({ timeout: 5000 }),
  );
  await tapAndReport(page, "page touch-action-none", () =>
    page.locator("#probe-touch-action-none").tap({ timeout: 5000 }),
  );
  await tapAndReport(page, "page cancels-pointerdown", () =>
    page.locator("#probe-cancels-pointerdown").tap({ timeout: 5000 }),
  );
  await tapAndReport(page, "page cancels-pointerdown-and-touch-action-none", () =>
    page.locator("#probe-cancels-pointerdown-and-touch-action-none").tap({ timeout: 5000 }),
  );
});

test("a tap on a blank page: the same four buttons, no app", async ({ page }) => {
  await page.setContent(
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body></body>',
  );
  await record(page);
  await addControls(page);
  await tapAndReport(page, "blank plain", () =>
    page.locator("#probe-plain").tap({ timeout: 5000 }),
  );
  await tapAndReport(page, "blank touch-action-none", () =>
    page.locator("#probe-touch-action-none").tap({ timeout: 5000 }),
  );
  await tapAndReport(page, "blank cancels-pointerdown", () =>
    page.locator("#probe-cancels-pointerdown").tap({ timeout: 5000 }),
  );
  await tapAndReport(page, "blank cancels-pointerdown-and-touch-action-none", () =>
    page.locator("#probe-cancels-pointerdown-and-touch-action-none").tap({ timeout: 5000 }),
  );
});
