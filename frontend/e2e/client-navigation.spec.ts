import type { Page } from "@playwright/test";

import { expect, test } from "./support/mock-api";
import { NOW, holdPlannerCode } from "./support/planner";

// R4-01 (D-46 3.1): a visit that arrives by navigating inside the app (the wordmark, or the Planner
// link) has no prerendered planner in its page. It must show the planner as the prerender drew it, at
// once, and never an empty page while the planner's code is on the way; the code then takes the
// drawing over in place, with no shift. The code is held back with `page.route` the way a slow link
// holds it, and the page is recorded from the click on: whether <main> was ever empty, and how far
// the layout moved.
test.use({ locale: "en-US", timezoneId: "America/Denver" });

/** An element that moved, as the page's layout-shift entry names it. */
interface MovedElement {
  readonly node: string;
  readonly from: string;
  readonly to: string;
}

/** One layout shift: how much, when (ms from the start of the recording), and what moved. */
interface Shift {
  readonly value: number;
  readonly at: number;
  readonly hadRecentInput: boolean;
  readonly moved: readonly MovedElement[];
}

/** Starts recording, in the page, whether `<main>` is ever empty and how far the layout shifts. */
async function recordPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    Reflect.set(window, "emptyMoments", 0);
    Reflect.set(window, "layoutShift", 0);
    Reflect.set(window, "shifts", []);
    new MutationObserver(() => {
      const main = document.querySelector("main");
      if (main !== null && main.childElementCount === 0) {
        Reflect.set(window, "emptyMoments", (Reflect.get(window, "emptyMoments") as number) + 1);
      }
    }).observe(document.body, { childList: true, subtree: true });
    // Only Chromium reports layout shifts; elsewhere the sum stays 0.
    if (PerformanceObserver.supportedEntryTypes.includes("layout-shift")) {
      interface ShiftEntry extends PerformanceEntry {
        readonly value: number;
        readonly hadRecentInput: boolean;
        readonly sources: readonly {
          readonly node: Node | null;
          readonly previousRect: DOMRectReadOnly;
          readonly currentRect: DOMRectReadOnly;
        }[];
      }
      const rectOf = (rect: DOMRectReadOnly): string =>
        `${String(Math.round(rect.x))},${String(Math.round(rect.y))} ${String(Math.round(rect.width))}x${String(Math.round(rect.height))}`;
      const nameOf = (node: Node | null): string => {
        if (!(node instanceof Element)) return String(node?.nodeName ?? "(removed)");
        const text = (node.textContent ?? "").trim().slice(0, 24);
        return `${node.localName}${node.id === "" ? "" : `#${node.id}`}.${node.getAttribute("class") ?? ""} "${text}"`;
      };
      const began = performance.now();
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as ShiftEntry[]) {
          Reflect.set(
            window,
            "layoutShift",
            (Reflect.get(window, "layoutShift") as number) + entry.value,
          );
          (Reflect.get(window, "shifts") as Shift[]).push({
            value: entry.value,
            at: Math.round(entry.startTime - began),
            hadRecentInput: entry.hadRecentInput,
            moved: entry.sources.map((source) => ({
              node: nameOf(source.node),
              from: rectOf(source.previousRect),
              to: rectOf(source.currentRect),
            })),
          });
        }
      }).observe({ type: "layout-shift" });
    }
  });
}

/** What `recordPage` has seen. */
async function recorded(
  page: Page,
): Promise<{ emptyMoments: number; layoutShift: number; shifts: Shift[] }> {
  return page.evaluate(() => ({
    emptyMoments: Reflect.get(window, "emptyMoments") as number,
    layoutShift: Reflect.get(window, "layoutShift") as number,
    shifts: Reflect.get(window, "shifts") as Shift[],
  }));
}

for (const start of ["/methodology", "/no-such-page"]) {
  test.describe(`the planner, reached from ${start} by the wordmark`, () => {
    test("shows the prerender's drawing at once, with the code still on the way, and the code takes it over in place", async ({
      page,
    }) => {
      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(message.text());
      });
      const held = await holdPlannerCode(page);
      await page.clock.setFixedTime(NOW);
      await page.goto(start);
      await page.evaluate(() => document.fonts.ready);
      await recordPage(page);
      const reads: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/") reads.push(request.resourceType());
      });

      await page.getByRole("link", { name: "Haulcast", exact: true }).click();
      await expect(page).toHaveURL(/\/$/u);

      // The planner as the prerender drew it: the heading, the panel and the form, drawn before any
      // code of the planner has arrived.
      const main = page.locator("main");
      await expect(main.getByRole("heading", { level: 1 })).toHaveText("Haulcast route planner");
      await expect(page.locator("[data-planner-panel]")).toBeVisible();
      await expect(page.locator("[data-planner-panel] form")).toBeVisible();
      // Arriving is the input: the code is asked for without one.
      await expect.poll(held.requested).toBe(true);
      expect(
        await page.evaluate(() => document.querySelector("main")?.childElementCount ?? 0),
      ).toBeGreaterThan(0);
      await page.evaluate(() => {
        Reflect.set(window, "formBefore", document.querySelector("form"));
      });

      await held.release();

      // The browser took the page over: only it knows what time it is.
      await expect(page.getByRole("group", { name: "Date" })).toContainText("10/21/2026");
      const sameForm = await page.evaluate(
        () => document.querySelector("form") === Reflect.get(window, "formBefore"),
      );
      expect(sameForm).toBe(true);
      // The drawing was read from the prerendered page, once.
      expect(reads).toEqual(["fetch"]);
      const seen = await recorded(page);
      expect(seen.emptyMoments).toBe(0);
      // A shift that happens names the elements that moved, so the failure says which they were.
      expect(seen.layoutShift, `the layout moved: ${JSON.stringify(seen.shifts)}`).toBe(0);
      expect(problems).toEqual([]);
    });
  });
}

test.describe("the prerendered planner", () => {
  test("is not read a second time by the page that already holds it", async ({ page }) => {
    const documents: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/") documents.push(request.resourceType());
    });
    await page.clock.setFixedTime(NOW);
    await page.goto("/");
    await page.getByRole("link", { name: "Methodology" }).first().click();
    await expect(page).toHaveURL(/\/methodology\/?$/u);

    // Only a visit that arrives by navigating reads the prerendered page for its drawing.
    expect(documents).toEqual(["document"]);
  });
});
