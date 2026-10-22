import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

interface RulesFile {
  readonly factors: Readonly<Record<string, { readonly label: string; readonly unit: string }>>;
}

// The rules file the scoring engine reads is the one the page's table is made from, so the test
// reads the file itself rather than a copy of its numbers.
const RULES = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../shared/risk-rules.json", import.meta.url)), "utf8"),
) as RulesFile;

/** The choices the page must explain, one heading each (T9 audit F-M1). */
const CHOICES = 11;

async function openMethodology(page: Page, { withScripts = true } = {}): Promise<void> {
  await page.goto("/methodology");
  await expect(
    page.getByRole("heading", { level: 1, name: "How Haulcast scores weather risk" }),
  ).toBeVisible();
  // Waiting for the fonts runs script; the test of the prerendered HTML has none to run.
  if (withScripts) await page.evaluate(() => document.fonts.ready);
}

test.describe("the methodology page", () => {
  test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });

    // The page is rendered to HTML at build time: what a crawler, an AI assistant and a slow
    // phone read before any script has run is the real content, not a shell.
    test("is prerendered with the thresholds table, the choices and the limits in the HTML", async ({
      page,
    }) => {
      await openMethodology(page, { withScripts: false });

      const table = page.getByRole("table", { name: "Risk level thresholds by weather factor" });
      await expect(table.getByRole("row")).toHaveCount(Object.keys(RULES.factors).length + 1);
      for (const factor of Object.values(RULES.factors)) {
        await expect(
          table.getByRole("rowheader", { name: `${factor.label} (${factor.unit})` }),
        ).toBeVisible();
      }
      await expect(
        page
          .getByRole("region", { name: "Choices we made on purpose" })
          .getByRole("heading", { level: 3 }),
      ).toHaveCount(CHOICES);
      for (const name of ["Assumptions", "Limitations", "Data sources and licenses"]) {
        await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
      }
    });
  });

  test("jumps to a section from the table of contents", async ({ page }) => {
    await openMethodology(page);

    await page
      .getByRole("navigation", { name: "On this page" })
      .getByRole("link", { name: "Limitations" })
      .click();

    await expect(page).toHaveURL(/#limits$/u);
    await expect(page.getByRole("heading", { level: 2, name: "Limitations" })).toBeInViewport();
  });

  test("opens every outside link in a new tab without handing over the opener", async ({
    page,
  }) => {
    await openMethodology(page);

    const outside = page.locator('main a[target="_blank"]');

    expect(await outside.count()).toBeGreaterThan(0);
    for (const link of await outside.all()) {
      await expect(link).toHaveAttribute("rel", /noopener/u);
      await expect(link).toHaveAttribute("rel", /noreferrer/u);
    }
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test.describe(`${colorScheme} theme`, () => {
      test.use({ colorScheme });

      test("has no axe violations", async ({ page }) => {
        await openMethodology(page);

        const { violations } = await new AxeBuilder({ page }).analyze();

        expect(
          violations.map(
            (violation) =>
              `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(" | ")}`,
          ),
        ).toEqual([]);
      });
    });
  }
});
