import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Forced colours (DESIGN.md 8.3). In Windows High Contrast the browser replaces the palette with
 * system colours, but it does not force the paint of an SVG shape: `fill` and `stroke` keep their
 * author values unless the stylesheet asks for a system colour itself, and an author rule with a
 * higher specificity beats the forced-colours rule. jsdom has no forced colours and no cascade
 * layers worth the name, so this can only be checked in a real engine.
 */

/** Three variants of each of the six levels (the five API levels and Unknown) on `/design`. */
const RISK_BADGE_COUNT = 18;

interface BadgeStyle {
  readonly level: string;
  readonly variant: string;
  readonly fill: string;
  readonly stroke: string;
  readonly borderColor: string;
  readonly color: string;
}

interface BadgeStyles {
  /** What `CanvasText` resolves to in this engine, so the test never hard-codes a palette. */
  readonly canvasText: string;
  readonly badges: readonly BadgeStyle[];
}

/** Opens `/design` with forced colours on, and skips when the engine cannot emulate them. */
async function openDesignInForcedColors(page: Page): Promise<void> {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/design");
  await expect(page.getByRole("heading", { level: 2, name: "Badge" })).toBeVisible();
  const active = await page.evaluate(() => window.matchMedia("(forced-colors: active)").matches);
  test.skip(!active, "this engine cannot emulate forced colours");
}

/** The computed style of every risk badge in the Badge specimen, and of the system colour. */
function readBadgeStyles(page: Page): Promise<BadgeStyles> {
  return page.evaluate((): BadgeStyles => {
    const probe = document.createElement("span");
    probe.style.color = "CanvasText";
    document.body.append(probe);
    const canvasText = getComputedStyle(probe).color;
    probe.remove();

    const badges = Array.from(
      document.querySelectorAll("[data-demo='Badge'] [data-variant][data-level]"),
      (badge): BadgeStyle => {
        const shape = badge.querySelector("svg");
        if (shape === null) {
          throw new Error("a risk badge has no shape icon");
        }
        const shapeStyle = getComputedStyle(shape);
        return {
          level: badge.getAttribute("data-level") ?? "",
          variant: badge.getAttribute("data-variant") ?? "",
          fill: shapeStyle.fill,
          stroke: shapeStyle.stroke,
          borderColor: getComputedStyle(badge).borderTopColor,
          color: getComputedStyle(badge).color,
        };
      },
    );
    return { canvasText, badges };
  });
}

test.describe("risk badge in forced colours", () => {
  test("draws its border, its shape and its word in CanvasText, in every variant and level", async ({
    page,
  }) => {
    await openDesignInForcedColors(page);

    const { canvasText, badges } = await readBadgeStyles(page);

    // A selector that matched nothing would pass the check below for the wrong reason.
    expect(badges.length).toBeGreaterThanOrEqual(RISK_BADGE_COUNT);
    expect(
      badges
        .filter(
          (badge) =>
            badge.fill !== "none" ||
            badge.stroke !== canvasText ||
            badge.borderColor !== canvasText ||
            badge.color !== canvasText,
        )
        .map(
          (badge) =>
            `${badge.level}/${badge.variant}: fill ${badge.fill}, stroke ${badge.stroke}, ` +
            `border ${badge.borderColor}, text ${badge.color} (CanvasText is ${canvasText})`,
        ),
    ).toEqual([]);
  });
});
