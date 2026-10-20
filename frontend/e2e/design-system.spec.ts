import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

type ThemeName = "light" | "dark";

const THEMES: readonly ThemeName[] = ["light", "dark"];
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
] as const;

/** Opens `/design` with the theme already saved, as a returning visitor would have it. */
async function openDesign(page: Page, theme: ThemeName): Promise<void> {
  await page.addInitScript((saved) => {
    window.localStorage.setItem("hc-theme", saved);
  }, theme);
  await page.goto("/design");
  await expect(page.getByRole("heading", { level: 1, name: "Design system" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  // A golden of fallback fonts would be a golden of the wrong thing.
  await page.evaluate(() => document.fonts.ready);
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test.describe(`/design, ${theme}, ${viewport.name} (${String(viewport.width)} px)`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      test("matches the visual golden", async ({ page }) => {
        await openDesign(page, theme);

        await expect(page).toHaveScreenshot(`design-${theme}-${viewport.name}.png`, {
          fullPage: true,
          animations: "disabled",
        });
      });

      test("has no accessibility violations", async ({ page }) => {
        await openDesign(page, theme);

        // Every axe rule runs, `region` included: the open tooltip and popover specimens are drawn
        // in place inside the page's landmarks, never portalled out of them.
        const results = await new AxeBuilder({ page }).analyze();

        expect(
          results.violations.map(
            (violation) =>
              `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(" | ")}`,
          ),
        ).toEqual([]);
      });
    });
  }
}

test.describe("theme", () => {
  test("is applied before the page scripts run, so there is no flash of the wrong theme", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("hc-theme", "dark");
    });
    // Without JavaScript only the inline script in <head> can have set the attribute.
    await page.route("**/*.js", (route) => route.abort());

    await page.goto("/");

    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("switches from the header, is remembered, and survives a reload", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("radio", { name: "Match system theme" })).toBeChecked();

    await page.getByRole("radio", { name: "Dark theme" }).click();

    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => window.localStorage.getItem("hc-theme"))).toBe("dark");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("radio", { name: "Dark theme" })).toBeChecked();
  });

  test("follows the operating system when set to system", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");

    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.emulateMedia({ colorScheme: "light" });
    const lightBackground = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );

    expect(background).not.toBe(lightBackground);
  });

  test("ships an inline script whose SHA-256 is the one recorded for the CSP", async ({
    request,
  }) => {
    const html = await (await request.get("/")).text();
    const inline = [...html.matchAll(/<script>([^<]*)<\/script>/g)].map((match) => match[1] ?? "");
    const recorded = JSON.parse(readFileSync("csp-hashes.json", "utf8")) as {
      themeInitScript: string;
    };

    const hashes = inline.map(
      (text) => `sha256-${createHash("sha256").update(text, "utf8").digest("base64")}`,
    );

    expect(hashes).toContain(recorded.themeInitScript);
  });
});

test.describe("page shell", () => {
  test("the skip link is hidden until it has keyboard focus, then it moves focus to the content", async ({
    page,
  }) => {
    await page.goto("/methodology");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    // Visually hidden means clipped: its box is still laid out, but nothing can be seen or clicked
    // there, so a hit test at its centre lands on whatever is underneath.
    const isOnTop = (): Promise<boolean> =>
      skip.evaluate((link) => {
        const box = link.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return hit !== null && link.contains(hit);
      });
    expect(await isOnTop()).toBe(false);

    await page.keyboard.press("Tab");

    await expect(skip).toBeFocused();
    expect(await isOnTop()).toBe(true);

    await page.keyboard.press("Enter");
    await expect(page.locator("main#main")).toBeFocused();
  });

  test("the footer credits the data sources with their licences", async ({ page }) => {
    await page.goto("/methodology");

    await expect(page.getByRole("contentinfo")).toContainText("OpenStreetMap");
    await expect(page.getByRole("contentinfo")).toContainText("Open-Meteo.com (CC BY 4.0)");
    await expect(page.getByRole("contentinfo")).toContainText("OpenFreeMap");
  });

  test("navigates between pages without a full reload", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      (window as unknown as { __stayed: boolean }).__stayed = true;
    });

    await page.getByRole("link", { name: "Methodology" }).click();

    await expect(page).toHaveURL(/\/methodology\/?$/);
    expect(await page.evaluate(() => (window as unknown as { __stayed?: boolean }).__stayed)).toBe(
      true,
    );
    await expect(page.getByRole("link", { name: "Methodology" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("shows the not-found page for an address that matches nothing", async ({ page }) => {
    await page.goto("/no-such-page");

    await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to the planner" })).toBeVisible();
  });

  test("keeps the kitchen sink out of search results", async ({ page }) => {
    await page.goto("/design");

    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex, nofollow",
    );
  });
});

/** Every violation as `rule: selector | selector`, so a failure says what to fix. */
async function violationsOn(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(" | ")}`,
  );
}

for (const theme of THEMES) {
  test.describe(`the shell pages, ${theme}`, () => {
    for (const path of ["/", "/methodology", "/no-such-page"]) {
      test(`${path} has no accessibility violations, landmarks included`, async ({ page }) => {
        await page.addInitScript((saved) => {
          window.localStorage.setItem("hc-theme", saved);
        }, theme);
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

        expect(await violationsOn(page)).toEqual([]);
      });
    }
  });
}

test.describe("responsive layout", () => {
  // The header and every page must fit the viewport: a phone that scrolls sideways is broken.
  for (const width of [360, 390, 412]) {
    for (const path of ["/", "/methodology", "/design", "/no-such-page"]) {
      test(`${path} does not scroll sideways at ${String(width)} px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(path);
        // The page itself, not the shell's loading state: every page has exactly one h1.
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );

        expect(overflow).toBeLessThanOrEqual(0);
      });
    }
  }
});
