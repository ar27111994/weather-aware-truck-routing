import type { Page } from "@playwright/test";

import { expect, test } from "./support/mock-api";
import { NOW, PLANNER_CODE, wakePlanner } from "./support/planner";

// R4-01 (D-46 3.1, D-47): the prerendered planner is the planner, so it is drawn in its own
// styles from the first paint. The planner's code is a lazy chunk and Vite ties the styles of what
// it draws to that chunk, so until `shellStyles` (scripts/chunking/shell-styles.ts) put them in
// the page of `/`, 61 of the 74 classes of the prerendered markup had no rule at all: the form
// came without its panel, its grid and its fields, with the busy marker showing, and the first
// input drew everything again with a jump. This test reads what the browser has, so that it holds
// whatever the markup and the rules are called.
test.use({ locale: "en-US", timezoneId: "America/Denver" });

/**
 * Whether a stylesheet of the page has a rule for each of the classes of the planner's markup:
 * the classes that CSS Modules wrote (`_name_hash_line`).
 *
 * @param page - The page under test.
 * @param names - The classes to look up; `null` for all that the markup of the planner holds now.
 */
async function ruled(
  page: Page,
  names: readonly string[] | null,
): Promise<Record<string, boolean>> {
  return page.evaluate((wanted) => {
    const hasRule = (rules: CSSRuleList, pattern: RegExp): boolean =>
      Array.from(rules).some(
        (rule) =>
          (rule instanceof CSSStyleRule && pattern.test(rule.selectorText)) ||
          ("cssRules" in rule && hasRule((rule as CSSGroupingRule).cssRules, pattern)),
      );
    const rulesOf = (sheet: CSSStyleSheet): CSSRuleList | null => {
      try {
        return sheet.cssRules;
      } catch {
        return null; // A sheet of another origin: the page's own are all of this one.
      }
    };
    const found = new Set<string>(wanted ?? []);
    if (wanted === null) {
      for (const element of document.querySelectorAll("[data-planner-island] [class]")) {
        for (const name of element.classList) {
          if (/^_.+_[a-z0-9]+_\d+$/u.test(name)) found.add(name);
        }
      }
    }
    const result: Record<string, boolean> = {};
    for (const name of found) {
      const pattern = new RegExp(`\\.${CSS.escape(name)}(?![\\w-])`, "u");
      result[name] = Array.from(document.styleSheets).some((sheet) => {
        const rules = rulesOf(sheet);
        return rules !== null && hasRule(rules, pattern);
      });
    }
    return result;
  }, names);
}

test.describe("the prerendered planner", () => {
  test("has, before any input, every rule that its code brings with it", async ({ page }) => {
    const code: string[] = [];
    page.on("request", (request) => {
      if (PLANNER_CODE.test(request.url())) code.push(request.url());
    });
    await page.clock.setFixedTime(NOW);
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);

    const first = await ruled(page, null);
    const names = Object.keys(first);
    // The markup is there, and nothing of the planner's code has been asked for.
    expect(names.length).toBeGreaterThan(40);
    expect(code).toEqual([]);

    // The planner's code brings all of its styles. What it has a rule for now, the page had one for
    // at the first paint.
    await wakePlanner(page);
    await expect(page.getByRole("group", { name: "Date" })).toContainText("10/21/2026");
    const later = await ruled(page, names);
    expect(names.filter((name) => later[name] === true && first[name] !== true)).toEqual([]);
  });
});
