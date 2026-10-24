import type { Page } from "@playwright/test";

import { expect, test } from "./support/mock-api";
import { NOW, holdPlannerCode, wakePlanner } from "./support/planner";

// PROBE (throwaway, never merged), R4F-E1 round 4: which ResizeObserver loops on iphone-14 (WebKit) in
// the flow of e2e/early-input.spec.ts:174, and what does it write in its callback? Every test runs that
// flow with a tracer that wraps window.ResizeObserver (creator stack, observed targets, one row per
// delivered callback with the target's border box before and after the callback and its style change),
// logs window error events with a snapshot of the page, scroll events and focus events, and prints the
// step markers with the number of errors that Playwright has seen so far. Variants (window.__e1) change
// how the combo box brings its input into view: V1 = shipped (scrollIntoView nearest on focus), V0 = no
// reveal, V2 = on open, V5 = scrollIntoViewIfNeeded(true) on focus (what a browser does by itself).
test.use({ locale: "en-US", timezoneId: "America/Denver" });

const FROM = /^From/u;
const TO = /^To/u;
const SHORT = 6000;

function installTracer(): void {
  const NativeRO = window.ResizeObserver;
  const pnow = performance.now.bind(performance);
  const log: unknown[] = [];
  Reflect.set(window, "__ro", log);
  let seq = 0;
  const t = (): number => Math.round(pnow() * 10) / 10;
  const round = (n: number): number => Math.round(n * 10) / 10;
  const desc = (el: unknown): string => {
    if (!(el instanceof Element)) return String(el);
    const cls =
      typeof el.className === "string" ? el.className.trim().split(/\s+/u).slice(0, 2).join(".") : "";
    const id = el.id ? "#" + el.id.slice(-8) : "";
    const trig = el.getAttribute("data-trigger");
    const role = el.getAttribute("role");
    return (
      el.localName +
      id +
      (cls ? "." + cls : "") +
      (role ? "[" + role + "]" : "") +
      (trig ? "{" + trig + "}" : "")
    );
  };
  const box = (el: Element): number[] => {
    const r = el.getBoundingClientRect();
    return [round(r.width), round(r.height)];
  };
  const rect = (el: Element | null): number[] | null => {
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return [round(r.left), round(r.top), round(r.width), round(r.height)];
  };
  const stackOf = (): string =>
    (new Error().stack ?? "")
      .split("\n")
      .slice(2, 10)
      .map((l) => l.trim().replace(/https?:\/\/[^/]+\/assets\//u, "").replace(/^at /u, ""))
      .join(" | ");
  const snapshot = (): unknown => {
    const scrollers = Array.from(document.querySelectorAll("*"))
      .filter((e) => e.scrollHeight > e.clientHeight + 1 && ["auto", "scroll"].includes(getComputedStyle(e).overflowY))
      .map((e) => desc(e) + " top=" + Math.round(e.scrollTop) + " ch=" + e.clientHeight + " sh=" + e.scrollHeight);
    const pop = document.querySelector("[data-trigger='ComboBox']");
    const vv = window.visualViewport;
    return {
      scrollers,
      winY: Math.round(window.scrollY),
      pop: rect(pop),
      popStyle: pop === null ? null : pop.getAttribute("style"),
      popPlacement: pop === null ? null : pop.getAttribute("data-placement"),
      inputs: Array.from(document.querySelectorAll("input[role='combobox']")).map(rect),
      active: desc(document.activeElement),
      vv: vv === null ? null : [round(vv.width), round(vv.height), round(vv.offsetTop), vv.scale],
      inner: [window.innerWidth, window.innerHeight],
    };
  };
  const Traced = class extends NativeRO {
    constructor(callback: ResizeObserverCallback) {
      const id = ++seq;
      super(function (this: ResizeObserver, entries: ResizeObserverEntry[], observer: ResizeObserver) {
        const start = t();
        const before = entries.map((e) => ({
          el: desc(e.target),
          box: box(e.target),
          style: e.target.getAttribute("style"),
          placement: e.target.getAttribute("data-placement"),
        }));
        try {
          return callback.call(this, entries, observer);
        } finally {
          const rows = entries.map((e, i) => {
            const afterBox = box(e.target);
            const afterStyle = e.target.getAttribute("style");
            const row: Record<string, unknown> = {
              el: before[i].el,
              rect: [round(e.contentRect.width), round(e.contentRect.height)],
              boxBefore: before[i].box,
              boxAfter: afterBox,
              changed: afterBox[0] !== before[i].box[0] || afterBox[1] !== before[i].box[1],
            };
            if (afterStyle !== before[i].style) {
              row.styleBefore = before[i].style;
              row.styleAfter = afterStyle;
            }
            const placement = e.target.getAttribute("data-placement");
            if (placement !== before[i].placement) {
              row.placementBefore = before[i].placement;
              row.placementAfter = placement;
            }
            return row;
          });
          log.push({ k: "cb", ro: id, t: start, end: t(), rows });
        }
      });
      Reflect.set(this, "__id", id);
      log.push({ k: "new", ro: id, t: t(), stack: stackOf() });
    }
    observe(target: Element, options?: ResizeObserverOptions): void {
      log.push({ k: "observe", ro: Reflect.get(this, "__id") as number, t: t(), el: desc(target) });
      super.observe(target, options);
    }
  };
  window.ResizeObserver = Traced;
  window.addEventListener("error", (event) => {
    log.push({ k: "error", t: t(), message: String(event.message), snap: snapshot() });
  });
  window.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      const top = target instanceof Element ? Math.round(target.scrollTop) : Math.round(window.scrollY);
      log.push({ k: "scroll", t: t(), el: desc(target instanceof Document ? "document" : target), top });
    },
    true,
  );
  window.addEventListener(
    "focusin",
    (event) => {
      log.push({ k: "focus", t: t(), el: desc(event.target) });
    },
    true,
  );
  Reflect.set(window, "__mark", (name: string) => {
    log.push({ k: "mark", t: t(), name, snap: snapshot() });
  });
}

async function attempt(label: string, name: string, action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    console.log(`CLICKERR ${label} ${name} ${String(error).split("\n").slice(0, 3).join(" | ").slice(0, 240)}`);
    return false;
  }
}

async function run(page: Page, label: string, options: { early: boolean; variant: string }): Promise<void> {
  const problems: string[] = [];
  page.on("pageerror", (error) => {
    problems.push(`pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  await page.addInitScript(installTracer);
  await page.addInitScript((v) => {
    Reflect.set(window, "__e1", v);
  }, options.variant);
  const held = await holdPlannerCode(page);
  await page.clock.setFixedTime(NOW);
  await page.goto("/");
  const mark = async (name: string): Promise<void> => {
    await page.evaluate((n) => (Reflect.get(window, "__mark") as (n: string) => void)(n), name);
    console.log(`STEP ${label} ${name} problems=${String(problems.length)}`);
  };
  try {
    await mark("loaded");
    const ten = page.getByRole("radio", { name: "10 mi" });
    if (options.early) {
      await page.getByText("10 mi", { exact: true }).click();
      await expect(ten).toBeChecked();
    } else {
      await wakePlanner(page);
    }
    await expect.poll(held.requested).toBe(true);
    await mark("early-input");
    await held.release();
    await expect(page.getByRole("group", { name: "Date" })).toContainText("10/21/2026");
    await expect(page.locator("form")).not.toHaveAttribute("aria-busy", /.*/u);
    await mark("hydrated");

    await attempt(label, "from-fill", () => page.getByRole("combobox", { name: FROM }).fill("salt", { timeout: SHORT }));
    await mark("from-filled");
    const picked = await attempt(label, "from-option", () =>
      page.getByRole("option", { name: /Salt Lake City/u }).click({ timeout: SHORT }),
    );
    await mark(picked ? "from-picked" : "from-NOT-picked");
    await attempt(label, "to-fill", () => page.getByRole("combobox", { name: TO }).fill("denv", { timeout: SHORT }));
    await mark("to-filled");
    const pickedTo = await attempt(label, "to-option", () =>
      page.getByRole("option", { name: /Denver/u }).click({ timeout: SHORT }),
    );
    await mark(pickedTo ? "to-picked" : "to-NOT-picked");
    await attempt(label, "load", () => page.getByRole("button", { name: "38,000" }).click({ timeout: SHORT }));
    await mark("load-picked");
    const planned = page.waitForRequest(
      (request) => request.method() === "POST" && request.url().endsWith("/api/v1/plans"),
      { timeout: SHORT },
    );
    await attempt(label, "plan", () => page.getByRole("button", { name: "Plan routes" }).click({ timeout: SHORT }));
    await mark("plan-clicked");
    const request = await planned.then(
      (r) => r,
      () => null,
    );
    await mark("plan-requested");
    console.log(
      `INTERVAL ${label} ${request === null ? "no-request" : String((request.postDataJSON() as { sampling_interval_mi: number }).sampling_interval_mi)}`,
    );
    console.log(`PROBLEMS-AT-TEST-END ${label} ${JSON.stringify(problems)}`);
    await page.waitForTimeout(3000);
    await mark("settled");
    console.log(`PROBLEMS-AT-SETTLED ${label} ${JSON.stringify(problems)}`);
  } finally {
    const rows = (await page.evaluate(() => Reflect.get(window, "__ro") as unknown[]).catch(() => [])) as unknown[];
    for (const row of rows) console.log(`RO ${label} ${JSON.stringify(row)}`);
    console.log(`RO-ROWS ${label} ${String(rows.length)}`);
  }
}

test.describe("resize observer probe", () => {
  test("A early click, V1 (shipped)", async ({ page }) => {
    await run(page, "A-early-V1", { early: true, variant: "V1" });
  });
  test("B pointer wake, V1 (control, no early click)", async ({ page }) => {
    await run(page, "B-wake-V1", { early: false, variant: "V1" });
  });
  test("C early click, V0 (no reveal)", async ({ page }) => {
    await run(page, "C-early-V0", { early: true, variant: "V0" });
  });
  test("D early click, V2 (reveal on open)", async ({ page }) => {
    await run(page, "D-early-V2", { early: true, variant: "V2" });
  });
  test("E early click, V5 (scrollIntoViewIfNeeded centre on focus)", async ({ page }) => {
    await run(page, "E-early-V5", { early: true, variant: "V5" });
  });
});
