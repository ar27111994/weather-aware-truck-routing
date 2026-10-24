import type { Page, Route } from "@playwright/test";

import { expect, test } from "./support/mock-api";

// THROWAWAY PROBE (card R4F-E3, never merged). The K6 test of early-input.spec.ts, step for step,
// with a recorder inside the page: which events the click made before hydration, which of them the
// intent gate saw, whether the replay called requestSubmit afterwards, and when the message showed.
// One line per run, "K6TRACE {json}", pass or fail, so that a failing run can be set against a
// passing one from the raw job log.
test.use({ locale: "en-US", timezoneId: "America/Denver" });

const NOW = new Date("2026-10-21T15:00:00Z");
const PLANNER_CODE = /\/assets\/PlannerApp-[\w-]+\.js(?:\?.*)?$/u;
const REQUIRED = "Choose a starting point from the list.";

const RECORDER = String.raw`(() => {
  const log = [];
  window.__k6 = log;
  const start = performance.now();
  const at = () => Math.round((performance.now() - start) * 10) / 10;
  const describe = (node) => {
    if (!(node instanceof Element)) return String((node && node.nodeName) || node);
    const cls = (node.getAttribute("class") || "").split(" ")[0];
    const text = (node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24);
    return node.tagName.toLowerCase() + (node.id ? "#" + node.id : "") + (cls ? "." + cls : "") +
      "[" + (node.getAttribute("role") || "") + "|" + (node.getAttribute("type") || "") + "]" + JSON.stringify(text);
  };
  const push = (kind, extra) => { log.push(Object.assign({ t: at(), kind: kind }, extra || {})); };
  push("install", { state: document.readyState });
  document.addEventListener("DOMContentLoaded", () => push("DOMContentLoaded"));
  window.addEventListener("load", () => push("load"));
  const types = ["pointermove", "pointerdown", "mousedown", "pointerup", "mouseup", "click", "submit", "focusin", "focusout", "keydown"];
  for (const type of types) {
    document.addEventListener(type, (e) => {
      push(type, { target: describe(e.target), x: e.clientX, y: e.clientY, trusted: e.isTrusted, active: describe(document.activeElement) });
    }, true);
    window.addEventListener(type, (e) => {
      push(type + "~after", { dp: e.defaultPrevented, target: describe(e.target) });
    }, false);
  }
  document.addEventListener("scroll", (e) => {
    const t = e.target;
    push("scroll", { target: describe(t), top: typeof t.scrollTop === "number" ? t.scrollTop : window.scrollY });
  }, true);
  const requestSubmit = HTMLFormElement.prototype.requestSubmit;
  HTMLFormElement.prototype.requestSubmit = function () {
    push("requestSubmit", { connected: this.isConnected, busy: this.getAttribute("aria-busy") });
    try { return requestSubmit.apply(this, arguments); } finally { push("requestSubmit~returned"); }
  };
  const REQUIRED = ${JSON.stringify(REQUIRED)};
  let seen = false;
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes") {
        push("attr", { target: describe(r.target), name: r.attributeName, value: r.target.getAttribute(r.attributeName) });
      } else {
        for (const n of r.removedNodes) if (n instanceof Element && (n.tagName === "FORM" || n.hasAttribute("data-planner-panel"))) push("removed", { node: describe(n) });
        for (const n of r.addedNodes) if (n instanceof Element && (n.tagName === "FORM" || n.hasAttribute("data-planner-panel"))) push("added", { node: describe(n) });
      }
    }
    const has = Boolean(document.body) && document.body.textContent.includes(REQUIRED);
    if (has !== seen) { seen = has; push("message", { present: has }); }
  }).observe(document, { attributes: true, attributeFilter: ["aria-busy", "data-busy"], childList: true, subtree: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (/PlannerApp-/.test(e.name)) push("resource", { name: e.name.slice(-32), start: Math.round(e.startTime), end: Math.round(e.responseEnd) });
    }
  }).observe({ type: "resource", buffered: true });
})();`;

interface Held {
  readonly requested: () => boolean;
  readonly release: () => Promise<void>;
}

async function holdCode(page: Page): Promise<Held> {
  const held: Route[] = [];
  let released = false;
  let requested = false;
  await page.route(PLANNER_CODE, (route) => {
    requested = true;
    if (released) void route.continue();
    else held.push(route);
  });
  return {
    requested: () => requested,
    release: async () => {
      released = true;
      for (const route of held.splice(0)) await route.continue();
    },
  };
}

const hydrated = (page: Page): Promise<void> =>
  expect(page.getByRole("group", { name: "Date" })).toContainText("10/21/2026");

test("K6 tracer: tapping Plan routes before hydration, checked once after it", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  const steps: { at: number; step: string }[] = [];
  const begin = Date.now();
  const note = (step: string): void => {
    steps.push({ at: Date.now() - begin, step });
  };
  let ok = false;
  await page.addInitScript({ content: RECORDER });
  const held = await holdCode(page);
  await page.clock.setFixedTime(NOW);
  try {
    await page.goto("/");
    note("loaded");
    await page.evaluate(() => {
      Reflect.set(window, "formBefore", document.querySelector("form"));
    });
    const history = await page.evaluate(() => window.history.length);

    await page.getByRole("button", { name: "Plan routes" }).click();
    note("click returned");
    await expect.poll(held.requested).toBe(true);
    note("code requested");
    expect(new URL(page.url()).search).toBe("");
    expect(await page.evaluate(() => window.history.length)).toBe(history);

    await held.release();
    note("released");
    await hydrated(page);
    note("hydrated");
    note(`count right after hydrated: ${String(await page.getByText(REQUIRED).count())}`);

    await expect(page.getByText(REQUIRED)).toHaveCount(1);
    note("message counted once");
    expect(
      await page.evaluate(() => document.querySelector("form") === Reflect.get(window, "formBefore")),
    ).toBe(true);
    expect(problems).toEqual([]);
    ok = true;
  } finally {
    const state = await page
      .evaluate(() => {
        const form = document.querySelector("form");
        return {
          busy: form?.getAttribute("aria-busy") ?? null,
          islandBusy: document.querySelector("[data-planner-island]")?.hasAttribute("data-busy") ?? null,
          active: document.activeElement?.tagName ?? null,
          formText: (form?.textContent ?? "").replace(/\s+/gu, " ").slice(0, 300),
          errors: Array.from(document.querySelectorAll("[id]"))
            .filter((element) => /error/iu.test(element.id))
            .map((element) => `${element.id}: ${(element.textContent ?? "").slice(0, 60)}`),
        };
      })
      .catch((error: unknown) => ({ evaluateFailed: String(error) }));
    const log = await page.evaluate(() => Reflect.get(window, "__k6") as unknown).catch(() => null);
    console.log(`K6TRACE ${JSON.stringify({ ok, steps, state, problems, log })}`);
  }
});
