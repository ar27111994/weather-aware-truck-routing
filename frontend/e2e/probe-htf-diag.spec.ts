// THROWAWAY PROBE (never merged): R4F-HTF, D-60. Who moves the focus when a pointer taps, clicks or
// drags the sheet's handle: it logs every pointer, mouse, touch, click and focus event of the page
// in order, and every script call of focus() and click() with where it came from. It asserts
// nothing, except that it saw events: the lines are the finding.
import type { Page } from "@playwright/test";

import { expect, test } from "./support/mock-api";
import { openPlanner } from "./support/planner";

test.use({ locale: "en-US", timezoneId: "America/Denver" });

interface Trace {
  readonly t: number;
  readonly text: string;
}

async function startTracing(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const trace: Trace[] = [];
    Object.assign(window, { __htfTrace: trace });
    const name = (node: unknown): string => {
      if (node === window) return "window";
      if (node === document) return "document";
      if (!(node instanceof Element)) return String(node);
      const label = node.getAttribute("aria-label");
      return node.tagName.toLowerCase() + (label === null ? "" : `[${label}]`);
    };
    const stack = (): string =>
      (new Error().stack ?? "")
        .split("\n")
        .slice(2, 5)
        .map((line) => line.trim().replace(/^at /u, "").replace(/https?:\/\/[^/]+/u, ""))
        .join(" < ");
    const nativeFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function focusTraced(this: HTMLElement, options?: FocusOptions) {
      trace.push({
        t: performance.now(),
        text: `CALL focus(${JSON.stringify(options ?? null)}) on ${name(this)} from ${stack()}`,
      });
      nativeFocus.call(this, options);
    };
    const nativeClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function clickTraced(this: HTMLElement) {
      trace.push({ t: performance.now(), text: `CALL click() on ${name(this)} from ${stack()}` });
      nativeClick.call(this);
    };
    const types = [
      "pointerdown",
      "pointerup",
      "pointercancel",
      "mousedown",
      "mouseup",
      "click",
      "touchstart",
      "touchend",
      "focusin",
      "focusout",
    ];
    for (const type of types) {
      window.addEventListener(
        type,
        (event) => {
          const e = event as PointerEvent;
          trace.push({
            t: performance.now(),
            text: `${type} trusted=${String(e.isTrusted)} pointerType=${e.pointerType ?? "-"} detail=${String(e.detail)} target=${name(e.target)} related=${name((event as FocusEvent).relatedTarget ?? null)}`,
          });
        },
        true,
      );
    }
  });
}

async function openTraced(page: Page): Promise<void> {
  await startTracing(page);
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    await page.setViewportSize({ width: 390, height: 780 });
  }
  await openPlanner(page);
  await expect(page.getByRole("region", { name: "Trip planner" })).toHaveAttribute(
    "data-snap",
    "half",
  );
}

async function report(page: Page, scenario: string): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 600)));
  const trace = await page.evaluate(() => (window as unknown as { __htfTrace: Trace[] }).__htfTrace);
  const active = await page.evaluate(() => {
    const a = document.activeElement;
    return a === null ? "null" : `${a.tagName.toLowerCase()}[${a.getAttribute("aria-label") ?? ""}]`;
  });
  const snap = await page.getByRole("region", { name: "Trip planner" }).getAttribute("data-snap");
  const first = trace.find((entry) => /^(pointerdown|mousedown|touchstart)/u.test(entry.text));
  const t0 = first?.t ?? trace[0]?.t ?? 0;
  const lines = trace.map((entry) => `  +${(entry.t - t0).toFixed(0).padStart(5)} ${entry.text}`);
  console.log(
    `PROBE-HTF ${test.info().project.name} | ${scenario} | active=${active} snap=${String(snap)}\n${lines.join("\n")}`,
  );
  expect(trace.length).toBeGreaterThan(0);
}

async function reset(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __htfTrace: Trace[] }).__htfTrace.length = 0;
  });
}

const HANDLE = (page: Page) =>
  page.getByRole("region", { name: "Trip planner" }).getByRole("button", { name: "Resize panel" });

test.describe("PROBE-HTF touch", () => {
  test.use({ hasTouch: true });

  test("tap, a field has the focus", async ({ page }) => {
    await openTraced(page);
    await page.getByRole("combobox", { name: /^From/u }).focus();
    await reset(page);
    await HANDLE(page).tap();
    await report(page, "touch tap, From field focused");
  });

  test("tap, nothing has the focus", async ({ page }) => {
    await openTraced(page);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await reset(page);
    await HANDLE(page).tap();
    await report(page, "touch tap, nothing focused");
  });
});

test.describe("PROBE-HTF mouse", () => {
  test("click, a field has the focus", async ({ page }) => {
    await openTraced(page);
    await page.getByRole("combobox", { name: /^From/u }).focus();
    await reset(page);
    await HANDLE(page).click();
    await report(page, "mouse click, From field focused");
  });

  test("drag that ends on the handle, a field has the focus", async ({ page }) => {
    await openTraced(page);
    await page.getByRole("combobox", { name: /^From/u }).focus();
    const box = await HANDLE(page).boundingBox();
    if (box === null) throw new Error("no handle box");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await reset(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 60, { steps: 6 });
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 200)));
    await page.mouse.up();
    await report(page, "mouse drag ending on the handle, From field focused");
  });
});
