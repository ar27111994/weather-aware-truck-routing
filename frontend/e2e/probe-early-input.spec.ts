import type { Page } from "@playwright/test";

import { expect, test } from "./support/mock-api";
import { NOW, holdPlannerCode, wakePlanner } from "./support/planner";

// PROBE (throwaway, never merged): why does the From field of early-input.spec.ts:174 stay empty
// after fill("salt") on Firefox and the Pixel 7? Every test logs what the page saw: the events at
// window (capture and bubble), who held the focus, the value of the field over time.
test.use({ locale: "en-US", timezoneId: "America/Denver" });

const FROM = /^From/u;

async function install(page: Page): Promise<void> {
  page.on("console", (message) => {
    console.log(`PAGECONSOLE ${message.type()} ${message.text().slice(0, 400)}`);
  });
  page.on("pageerror", (error) => {
    console.log(`PAGEERROR ${error.message.slice(0, 400)}`);
  });
  await page.addInitScript(() => {
    const log: Record<string, unknown>[] = [];
    Reflect.set(window, "__probe", log);
    // Who sets the value of a combobox input, and from where (minified frames, mapped by the build).
    const proto = HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor?.set !== undefined && descriptor.get !== undefined) {
      const nativeSet = descriptor.set;
      Object.defineProperty(proto, "value", {
        configurable: true,
        enumerable: descriptor.enumerable ?? false,
        get: descriptor.get,
        set(this: HTMLInputElement, next: string) {
          if (this.getAttribute("role") === "combobox") {
            log.push({
              n: log.length,
              type: "value-set",
              value: next,
              was: this.value,
              stack: (new Error().stack ?? "")
                .split("\n")
                .slice(1, 9)
                .map((line) => line.trim().replace(/https?:\/\/[^/]+\/assets\//u, ""))
                .join(" | "),
            });
          }
          nativeSet.call(this, next);
        },
      });
    }
    // Is a combobox input ever taken out of the page or put in?
    new MutationObserver((records) => {
      for (const record of records) {
        for (const [kind, nodes] of [
          ["removed", record.removedNodes],
          ["added", record.addedNodes],
        ] as const) {
          for (const node of nodes) {
            if (
              node instanceof Element &&
              (node.matches("input[role='combobox']") ||
                node.querySelector("input[role='combobox']") !== null)
            ) {
              log.push({ n: log.length, type: `mutation-${kind}`, target: node.localName });
            }
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
    const describe = (target: EventTarget | null): string => {
      if (!(target instanceof Element)) return String(target);
      const role = target.getAttribute("role");
      const id = target.id === "" ? "" : `#${target.id.slice(-8)}`;
      return `${target.localName}${id}${role === null ? "" : `[${role}]`}`;
    };
    const types = [
      "pointerdown",
      "click",
      "focusin",
      "focusout",
      "beforeinput",
      "input",
      "change",
      "keydown",
      "compositionstart",
      "compositionend",
      "reset",
      "submit",
    ];
    for (const type of types) {
      for (const capture of [true, false]) {
        window.addEventListener(
          type,
          (event) => {
            const target = event.target;
            log.push({
              n: log.length,
              type,
              phase: capture ? "capture" : "bubble",
              target: describe(target),
              prevented: event.defaultPrevented,
              data: (event as InputEvent).data ?? null,
              inputType: (event as InputEvent).inputType ?? null,
              value: target instanceof HTMLInputElement ? target.value : null,
              active: describe(document.activeElement),
            });
          },
          capture,
        );
      }
    }
    let last: string | null = "unset";
    let polls = 0;
    setInterval(() => {
      const input = document.querySelector<HTMLInputElement>("input[role='combobox']");
      const value = input === null ? null : input.value;
      if (value !== last) {
        last = value;
        log.push({ n: log.length, type: "poll-value", value, polls });
      }
      polls += 1;
    }, 5);
  });
}

/** The prerendered page, the planner's code held; "10 mi" is chosen; the code is let through. */
async function early(page: Page): Promise<void> {
  const held = await holdPlannerCode(page);
  await page.clock.setFixedTime(NOW);
  await page.goto("/");
  await page.getByText("10 mi", { exact: true }).click();
  await expect.poll(held.requested).toBe(true);
  await held.release();
  await expect(page.getByRole("group", { name: "Date" })).toContainText("10/21/2026");
  await expect(page.locator("form")).not.toHaveAttribute("aria-busy", /.*/u);
}

async function report(page: Page, label: string): Promise<void> {
  const state = await page.evaluate(() => ({
    log: Reflect.get(window, "__probe") as Record<string, unknown>[],
    active: document.activeElement?.outerHTML.slice(0, 160) ?? null,
    hasFocus: document.hasFocus(),
    busy: document.querySelector("form")?.getAttribute("aria-busy") ?? null,
    scrollTops: Array.from(document.querySelectorAll("*"))
      .filter((element) => element.scrollTop > 0)
      .map((element) => `${element.localName}.${element.getAttribute("class") ?? ""}:${String(element.scrollTop)}`),
  }));
  const interesting = state.log.filter((entry) => entry["type"] !== "pointerdown" || true);
  console.log(
    `PROBE ${label} ${JSON.stringify({ ...state, log: undefined })}\nPROBELOG ${label} ${JSON.stringify(interesting)}`,
  );
}

test.describe("probe", () => {
  test("A: the failing flow", async ({ page }) => {
    await install(page);
    await early(page);
    const from = page.getByRole("combobox", { name: FROM });
    await from.fill("salt");
    await page.waitForTimeout(800);
    await report(page, "A");
    await expect(from).toHaveValue("salt");
  });

  test("B: the failing flow after two more seconds", async ({ page }) => {
    await install(page);
    await early(page);
    await page.waitForTimeout(2000);
    const from = page.getByRole("combobox", { name: FROM });
    await from.fill("salt");
    await page.waitForTimeout(800);
    await report(page, "B");
    await expect(from).toHaveValue("salt");
  });

  test("C: the failing flow, typed key by key", async ({ page }) => {
    await install(page);
    await early(page);
    const from = page.getByRole("combobox", { name: FROM });
    await from.pressSequentially("salt");
    await page.waitForTimeout(800);
    await report(page, "C");
    await expect(from).toHaveValue("salt");
  });

  test("D: control, the planner woken by the pointer", async ({ page }) => {
    await install(page);
    await page.clock.setFixedTime(NOW);
    await page.goto("/");
    await wakePlanner(page);
    await expect(page.getByRole("group", { name: "Date" })).toContainText("10/21/2026");
    await page.evaluate(() => document.fonts.ready);
    const from = page.getByRole("combobox", { name: FROM });
    await from.fill("salt");
    await page.waitForTimeout(800);
    await report(page, "D");
    await expect(from).toHaveValue("salt");
  });

  test("E: the failing flow, the field clicked before it is filled", async ({ page }) => {
    await install(page);
    await early(page);
    const from = page.getByRole("combobox", { name: FROM });
    await from.click();
    await from.fill("salt");
    await page.waitForTimeout(800);
    await report(page, "E");
    await expect(from).toHaveValue("salt");
  });

  test("F: the failing flow, the To field filled", async ({ page }) => {
    await install(page);
    await early(page);
    const to = page.getByRole("combobox", { name: /^To/u });
    await to.fill("denv");
    await page.waitForTimeout(800);
    await report(page, "F");
    await expect(to).toHaveValue("denv");
  });

  test("G: the failing flow without the early click, the code released by a typed letter", async ({
    page,
  }) => {
    await install(page);
    const held = await holdPlannerCode(page);
    await page.clock.setFixedTime(NOW);
    await page.goto("/");
    await page.getByRole("combobox", { name: /^To/u }).pressSequentially("x");
    await expect.poll(held.requested).toBe(true);
    await held.release();
    await expect(page.getByRole("group", { name: "Date" })).toContainText("10/21/2026");
    await expect(page.locator("form")).not.toHaveAttribute("aria-busy", /.*/u);
    const from = page.getByRole("combobox", { name: FROM });
    await from.fill("salt");
    await page.waitForTimeout(800);
    await report(page, "G");
    await expect(from).toHaveValue("salt");
  });
});
