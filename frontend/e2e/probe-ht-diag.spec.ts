// THROWAWAY PROBE (never merged): R4F-HT, BS-F1. What a touch tap on the sheet's handle sends, and
// whether React Aria's press takes it for a real pointer press (a pointerdown with a zero width and
// height is read as a screen reader's, and ignored). It logs; its only assertion is that it saw events.
import { expect, test } from "./support/mock-api";
import { openPlanner } from "./support/planner";

test.use({ locale: "en-US", timezoneId: "America/Denver", hasTouch: true });

test("PROBE-HT: what a tap on the handle sends", async ({ page }) => {
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    await page.setViewportSize({ width: 390, height: 780 });
  }
  await openPlanner(page);
  const handle = page
    .getByRole("region", { name: "Trip planner" })
    .getByRole("button", { name: "Resize panel" });
  const log = await page.evaluateHandle(() => {
    const entries: string[] = [];
    for (const type of ["pointerdown", "pointerup", "click", "touchstart", "touchend", "focusin"]) {
      window.addEventListener(
        type,
        (event) => {
          const e = event as PointerEvent;
          entries.push(
            [
              type,
              e.pointerType ?? "",
              e.width ?? "",
              e.height ?? "",
              e.pressure ?? "",
              e.detail ?? "",
              e.isTrusted,
              (e.target as Element | null)?.tagName ?? "",
            ].join(":"),
          );
        },
        true,
      );
    }
    return entries;
  });
  await handle.tap();
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 800)));
  const entries = await log.jsonValue();
  const snap = await page.getByRole("region", { name: "Trip planner" }).getAttribute("data-snap");
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? "");
  console.log(`PROBE-HT ${test.info().project.name} ${JSON.stringify({ entries, snap, focused })}`);
  expect(entries.length).toBeGreaterThan(0);
});
