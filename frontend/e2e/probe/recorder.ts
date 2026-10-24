import type { Page, Route } from "@playwright/test";

// THROWAWAY PROBE HELPERS (card R4F-E3, never merged): the recorder that runs inside the page, the
// way to hold the planner's code back, and the one-line "K6TRACE {json}" dump that the two probe
// specs print at the end of every run, pass or fail.

export const NOW = new Date("2026-10-21T15:00:00Z");
export const PLANNER_CODE = /\/assets\/PlannerApp-[\w-]+\.js(?:\?.*)?$/u;
export const REQUIRED = "Choose a starting point from the list.";

export const RECORDER = String.raw`(() => {
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
  const btnRect = () => {
    const b = document.querySelector("form button[type=submit]");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  };
  push("install", { state: document.readyState });
  document.addEventListener("DOMContentLoaded", () => push("DOMContentLoaded"));
  window.addEventListener("load", () => push("load"));
  const types = ["pointermove", "pointerdown", "mousedown", "pointerup", "mouseup", "click", "submit", "focusin", "focusout", "keydown"];
  for (const type of types) {
    document.addEventListener(type, (e) => {
      push(type, { target: describe(e.target), x: e.clientX, y: e.clientY, trusted: e.isTrusted, active: describe(document.activeElement), sheets: document.styleSheets.length, btn: type === "pointerdown" || type === "pointerup" || type === "click" ? btnRect() : undefined });
    }, true);
    window.addEventListener(type, (e) => {
      push(type + "~after", { dp: e.defaultPrevented, target: describe(e.target) });
    }, false);
  }
  document.addEventListener("load", (e) => {
    const t = e.target;
    if (t instanceof HTMLLinkElement) push("link-load", { rel: t.rel, href: t.href.slice(-44), sheets: document.styleSheets.length });
  }, true);
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
        for (const n of r.addedNodes) {
          if (n instanceof HTMLLinkElement) push("link-added", { rel: n.rel, href: n.href.slice(-44) });
          if (n instanceof Element && (n.tagName === "FORM" || n.hasAttribute("data-planner-panel"))) push("added", { node: describe(n) });
        }
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

/** The planner's code, held back until the test lets it through. */
export interface Held {
  readonly requested: () => boolean;
  readonly release: () => Promise<void>;
}

export async function holdCode(page: Page): Promise<Held> {
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

export interface Step {
  readonly at: number;
  readonly step: string;
}

/** Prints the run as one line: the verdict, the steps, the page's state and the recorder's log. */
export async function dumpTrace(
  page: Page,
  tag: string,
  ok: boolean,
  steps: readonly Step[],
  problems: readonly string[],
): Promise<void> {
  const state = await page
    .evaluate(() => {
      const form = document.querySelector("form");
      return {
        busy: form?.getAttribute("aria-busy") ?? null,
        islandBusy: document.querySelector("[data-planner-island]")?.hasAttribute("data-busy") ?? null,
        active: document.activeElement?.tagName ?? null,
        sheets: document.styleSheets.length,
        formText: (form?.textContent ?? "").replace(/\s+/gu, " ").slice(0, 300),
        errors: Array.from(document.querySelectorAll("[id]"))
          .filter((element) => /error/iu.test(element.id))
          .map((element) => `${element.id}: ${(element.textContent ?? "").slice(0, 60)}`),
      };
    })
    .catch((error: unknown) => ({ evaluateFailed: String(error) }));
  const log = await page.evaluate(() => Reflect.get(window, "__k6") as unknown).catch(() => null);
  console.log(`K6TRACE ${JSON.stringify({ tag, ok, steps, state, problems, log })}`);
}
