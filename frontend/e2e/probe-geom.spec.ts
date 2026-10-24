import type { Page } from "@playwright/test";

import { expect, test } from "./support/mock-api";
import { NOW, holdPlannerCode } from "./support/planner";

// PROBE (throwaway, never merged), R4F-E1 round 3: why is the option of early-input.spec.ts:174
// "outside of the viewport" on iphone-14 (WebKit)? Every test runs the failing flow and logs the
// geometry of the page after the fill, and whether the option can be clicked, for the product with the
// scroll guard (V0) and for four candidate behaviours (V1 to V4, chosen by window.__e1).
test.use({ locale: "en-US", timezoneId: "America/Denver" });

const FROM = /^From/u;

async function settle(page: Page): Promise<void> {
  await expect(page.getByRole("group", { name: "Date" })).toContainText("10/21/2026");
  await expect(page.locator("form")).not.toHaveAttribute("aria-busy", /.*/u);
}

async function early(page: Page): Promise<void> {
  const held = await holdPlannerCode(page);
  await page.clock.setFixedTime(NOW);
  await page.goto("/");
  await page.getByText("10 mi", { exact: true }).click();
  await expect.poll(held.requested).toBe(true);
  await held.release();
  await settle(page);
}

async function geom(page: Page, label: string): Promise<void> {
  const g = await page.evaluate(() => {
    const rect = (el: Element | null): number[] | null => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
    };
    const input = document.querySelector<HTMLInputElement>("input[role='combobox']");
    let scroller: HTMLElement | null = null;
    for (let el = input?.parentElement ?? null; el !== null; el = el.parentElement) {
      const overflow = getComputedStyle(el).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight) {
        scroller = el;
        break;
      }
    }
    const popover = document.querySelector("[data-trigger='ComboBox']");
    const vv = window.visualViewport;
    return {
      inner: [window.innerWidth, window.innerHeight],
      vv:
        vv === null
          ? null
          : {
              w: Math.round(vv.width),
              h: Math.round(vv.height),
              top: Math.round(vv.offsetTop),
              pageTop: Math.round(vv.pageTop),
              scale: vv.scale,
            },
      winY: Math.round(window.scrollY),
      docH: document.documentElement.scrollHeight,
      scroller:
        scroller === null
          ? null
          : {
              cls: scroller.className.slice(0, 24),
              top: Math.round(scroller.scrollTop),
              clientH: scroller.clientHeight,
              scrollH: scroller.scrollHeight,
              rect: rect(scroller),
            },
      input: rect(input),
      popover: popover === null ? null : { rect: rect(popover), style: popover.getAttribute("style") },
      option: rect(document.querySelector("[role='option']")),
      value: input?.value ?? null,
    };
  });
  console.log(`GEOM ${label} ${JSON.stringify(g)}`);
}

async function failingFlow(page: Page, label: string, reveal = false): Promise<boolean> {
  await early(page);
  await geom(page, `${label} before-fill`);
  const from = page.getByRole("combobox", { name: FROM });
  if (reveal) await from.scrollIntoViewIfNeeded();
  await from.fill("salt");
  await geom(page, `${label} +0`);
  await page.waitForTimeout(150);
  await geom(page, `${label} +150`);
  await page.waitForTimeout(800);
  await geom(page, `${label} +950`);
  let clicked = true;
  try {
    await page.getByRole("option", { name: /Salt Lake City/u }).click({ timeout: 4000 });
  } catch (error) {
    clicked = false;
    console.log(`CLICKERR ${label} ${String(error).split("\n").slice(0, 3).join(" | ").slice(0, 220)}`);
  }
  console.log(`RESULT ${label} value=${await from.inputValue()} clicked=${String(clicked)}`);
  return clicked;
}

test.describe("geometry probe", () => {
  for (const variant of ["V0", "V1", "V2", "V3", "V4"]) {
    test(`${variant}: the failing flow`, async ({ page }) => {
      await page.addInitScript((v) => {
        Reflect.set(window, "__e1", v);
      }, variant);
      expect(await failingFlow(page, variant)).toBe(true);
    });
  }

  test("G2: the failing flow, the field scrolled into view before the fill", async ({ page }) => {
    await page.addInitScript(() => {
      Reflect.set(window, "__e1", "V0");
    });
    expect(await failingFlow(page, "G2", true)).toBe(true);
  });
});
