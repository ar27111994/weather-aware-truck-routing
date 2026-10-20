import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

// Goldens are tagged `@golden`; only the `chromium` project runs them (playwright.config.ts), so
// they are made and compared by one engine on one platform. Pixels depend on the platform's font
// rasteriser, so that platform is the Linux runner of CI: the "Update visual goldens" workflow
// (.github/workflows/goldens.yml) makes the baselines there and CI compares against them. On any
// other operating system a comparison could only be a false alarm, so it is skipped there and
// nowhere else.
test.describe("visual goldens", () => {
  test.skip(
    process.platform !== "linux",
    "goldens are made and enforced on Linux (CI); run the Update visual goldens workflow to refresh them",
  );
  // A golden that needs a second try to pass is a flaky golden, not a passing one.
  test.describe.configure({ retries: 0 });

  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test.describe(`/design, ${theme}, ${viewport.name} (${String(viewport.width)} px)`, () => {
        test.use({ viewport: { width: viewport.width, height: viewport.height } });

        test("matches the visual golden", { tag: "@golden" }, async ({ page }) => {
          await openDesign(page, theme);

          await expect(page).toHaveScreenshot(`design-${theme}-${viewport.name}.png`, {
            fullPage: true,
            animations: "disabled",
          });
        });
      });
    }
  }
});

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test.describe(`/design, ${theme}, ${viewport.name} (${String(viewport.width)} px)`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

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

/**
 * Puts one bare native control of each common kind into the page, with no class and no component
 * around it, as markup from outside the design system (a third-party widget, an embedded snippet)
 * would arrive. Returns the id of the element that holds them.
 */
async function appendBareControls(page: Page): Promise<string> {
  const hostId = "bare-controls";
  await page.evaluate((id) => {
    const host = document.createElement("div");
    host.id = id;
    const button = Object.assign(document.createElement("button"), { type: "button" });
    button.textContent = "Bare button";
    const buttonInput = Object.assign(document.createElement("input"), {
      type: "button",
      value: "Bare input button",
    });
    const submitInput = Object.assign(document.createElement("input"), {
      type: "submit",
      value: "Bare submit",
    });
    const textInput = Object.assign(document.createElement("input"), {
      type: "text",
      value: "Bare text input",
    });
    textInput.setAttribute("aria-label", "Bare text input");
    const textarea = Object.assign(document.createElement("textarea"), {
      value: "Bare textarea",
    });
    textarea.setAttribute("aria-label", "Bare textarea");
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Bare select");
    select.append(Object.assign(document.createElement("option"), { textContent: "Bare select" }));
    host.append(button, buttonInput, submitInput, textInput, textarea, select);
    document.querySelector("main")?.append(host);
  }, hostId);
  return hostId;
}

test.describe("bare native controls", () => {
  for (const theme of THEMES) {
    // The reset gives controls the theme's ink (`color: inherit`). A control that kept the browser's
    // own face next to that ink is legible in one engine and not in another: WebKit never darkens
    // ButtonFace for `color-scheme: dark`, so light ink landed on silver (1.7:1).
    test(`stay legible in the ${theme} theme`, async ({ page }) => {
      await openDesign(page, theme);
      const hostId = await appendBareControls(page);

      const results = await new AxeBuilder({ page })
        .include(`#${hostId}`)
        .withRules(["color-contrast"])
        .analyze();

      expect(
        results.violations.flatMap((violation) =>
          violation.nodes.map((node) => `${violation.id}: ${node.html}`),
        ),
      ).toEqual([]);
    });
  }
});

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

  test("the attribution links point at the real pages, in the prerendered HTML and after hydration", async ({
    page,
    request,
  }) => {
    const links = [
      ["OpenStreetMap", "https://www.openstreetmap.org/copyright"],
      ["OpenFreeMap", "https://openfreemap.org"],
      ["Open-Meteo.com", "https://open-meteo.com"],
      ["Source on GitHub", "https://github.com/ar27111994/weather-aware-truck-routing"],
    ] as const;

    // Crawlers and visitors without JavaScript only ever see the prerendered markup.
    const html = await (await request.get("/methodology")).text();
    for (const [, href] of links) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).not.toContain("/https:/");

    await page.goto("/methodology");
    for (const [name, href] of links) {
      await expect(page.getByRole("contentinfo").getByRole("link", { name })).toHaveAttribute(
        "href",
        href,
      );
    }
  });

  test("a tooltip stays open while the pointer rests on it", async ({ page }) => {
    await page.goto("/");
    // React Aria opens a tooltip on hover once the page has seen a pointer press (keyboard focus
    // opens it at once), so press somewhere neutral first, as any visitor with a mouse has done.
    await page.mouse.click(2, 300);
    await page.getByRole("radio", { name: "Dark theme" }).hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    const box = await tooltip.boundingBox();
    if (box === null) {
      throw new Error("the visible tooltip has no box");
    }

    // WCAG 1.4.13: someone using a magnifier has to be able to move onto the tooltip and read it.
    // The wait is longer than the tooltip's close delay, so a tooltip that ignores the pointer is gone.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(1200);

    await expect(tooltip).toBeVisible();
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

/**
 * WCAG 2.4.11: a focused control is never entirely hidden behind author-created content, and the
 * header of every page is sticky. One test per component section of `/design` (every folder of
 * `components/` is one section; `demo-registry.test.tsx` pins that), not one test for the page.
 * The page has about a hundred tab stops, a real key press costs 0.15 to 0.2 s on a slow phone
 * emulation, and a single test that walked them all timed out on an iPhone 14 runner at about 100.
 * A section has a handful of stops, so each test takes a few seconds on any machine, runs in
 * parallel with the others, and names the section it fails in.
 */
const SECTIONS = readdirSync(
  fileURLToPath(new URL("../app/design-system/components/", import.meta.url)),
  {
    withFileTypes: true,
  },
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted((left, right) => left.localeCompare(right, "en"));

/** Sections that have keyboard stops. A helper that finds none anywhere would pass everything. */
const SECTIONS_WITH_STOPS = new Set([
  "Button",
  "Chip",
  "IconButton",
  "Legend",
  "Link",
  "Popover",
  "Segmented",
  "Slider",
  "Switch",
  "ThemeToggle",
  "Tooltip",
]);

interface BackwardsWalk {
  /** Tab stops visited, from the end of the section back to its start. */
  readonly stops: number;
  /** The stops whose control was hidden behind the header. */
  readonly covered: readonly string[];
}

/**
 * Walks the tab stops of one section backwards with real key presses and reports any that the
 * sticky header covers. It starts on a sentinel just after the section, scrolled to the top of the
 * window, so the previous stop is above the window and the browser has to scroll it into view
 * from above: the case the header gets in the way of. It stops as soon as focus leaves the
 * section, so it never walks further than the section is long.
 */
async function tabBackwardsThrough(page: Page, section: string): Promise<BackwardsWalk> {
  await page.setViewportSize({ width: 1280, height: 500 });
  await page.goto("/design");
  await expect(page.locator(`section[data-demo="${section}"]`)).toHaveCount(1);
  await page.evaluate((name) => {
    const target = document.querySelector(`section[data-demo="${name}"]`);
    const main = document.querySelector("main");
    if (target === null || main === null) {
      throw new Error(`the ${name} section is not on /design`);
    }
    // Room below the last section, so any section can be scrolled to the top of the window.
    main.style.paddingBlockEnd = "200vh";
    const sentinel = document.createElement("span");
    sentinel.tabIndex = -1;
    target.after(sentinel);
    sentinel.scrollIntoView({ block: "start" });
    sentinel.focus({ preventScroll: true });
  }, section);

  const covered: string[] = [];
  let stops = 0;
  const longestSection = 40;
  for (let press = 0; press < longestSection; press += 1) {
    await page.keyboard.press("Shift+Tab");
    const state = await page.evaluate((name) => {
      const target = document.querySelector(`section[data-demo="${name}"]`);
      const header = document.querySelector("header");
      const active = document.activeElement;
      if (target === null || header === null || active === null || !target.contains(active)) {
        return null;
      }
      const rect = active.getBoundingClientRect();
      // What is on top at the control's centre: the control itself (or something inside it) when
      // it is visible, the header when the header covers it.
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        label: active.getAttribute("aria-label") ?? active.textContent.trim().slice(0, 40),
        top: rect.top,
        headerBottom: header.getBoundingClientRect().bottom,
        onTop: hit !== null && (active.contains(hit) || hit.contains(active)),
      };
    }, section);
    if (state === null) {
      return { stops, covered };
    }
    stops += 1;
    if (state.top < state.headerBottom - 0.5 && !state.onTop) {
      covered.push(
        `${state.label} (top ${String(state.top)}, header ends ${String(state.headerBottom)})`,
      );
    }
  }
  throw new Error(`the ${section} section has more than ${String(longestSection)} tab stops`);
}

test.describe("tabbing backwards never leaves the focused control under the sticky header", () => {
  for (const section of SECTIONS) {
    test(`in the ${section} section`, async ({ page }) => {
      const walk = await tabBackwardsThrough(page, section);

      expect(walk.covered).toEqual([]);
      if (SECTIONS_WITH_STOPS.has(section)) {
        expect(walk.stops, `the ${section} section has keyboard stops`).toBeGreaterThan(0);
      }
    });
  }
});

test.describe("the kitchen sink and the first load (D-27)", () => {
  /** Only the kitchen sink says this: it is the description inside a demo file, not microcopy. */
  const SINK_ONLY_TEXT = "Content for screen readers only.";

  /** The text of every script a page loads, once it has settled. */
  async function loadedScripts(page: Page, path: string): Promise<string[]> {
    const bodies: Promise<string>[] = [];
    page.on("response", (response) => {
      if (response.request().resourceType() === "script") {
        bodies.push(response.text());
      }
    });
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    return Promise.all(bodies);
  }

  test("is a chunk of its own: the planner's first load does not carry it", async ({ page }) => {
    const scripts = await loadedScripts(page, "/");

    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.filter((script) => script.includes(SINK_ONLY_TEXT))).toHaveLength(0);
  });

  test("is loaded when /design is opened, so the check above can fail", async ({ page }) => {
    const scripts = await loadedScripts(page, "/design");

    expect(scripts.some((script) => script.includes(SINK_ONLY_TEXT))).toBe(true);
  });
});

/**
 * The header's primary navigation (DESIGN.md section 10). From 640 px both links are shown and the
 * one for the page being viewed carries `aria-current="page"`. On a phone the header keeps room for
 * the theme toggle by leaving out the link to the page the visitor is already on; the wordmark is
 * the way home at every width. The expectation therefore depends on the width, so each width is
 * pinned here instead of following whichever device project happens to run the test.
 */
const NAVIGATION_WIDTHS = [
  { name: "desktop", width: 1280, height: 800, currentLinkShown: true },
  { name: "phone", width: 390, height: 844, currentLinkShown: false },
] as const;

for (const layout of NAVIGATION_WIDTHS) {
  test.describe(`primary navigation, ${layout.name} (${String(layout.width)} px)`, () => {
    test.use({ viewport: { width: layout.width, height: layout.height } });

    test("moves between pages without a full reload and marks the page it is on", async ({
      page,
    }) => {
      await page.goto("/");
      await page.evaluate(() => {
        Reflect.set(window, "__stayed", true);
      });
      const navigation = page.getByRole("navigation", { name: "Primary" });
      const current = navigation.locator('a[aria-current="page"]');

      // On the planner the other page is always offered, at every width.
      await navigation.getByRole("link", { name: "Methodology" }).click();

      await expect(page).toHaveURL(/\/methodology\/?$/);
      await expect(current).toHaveText("Methodology");
      // The page is marked for assistive technology at every width; only a phone leaves the link out
      // of the layout.
      await expect(current).toBeVisible({ visible: layout.currentLinkShown });

      // The wordmark is the way home whether or not the Planner link is shown.
      await page.getByRole("link", { name: "Haulcast", exact: true }).click();

      await expect(page).toHaveURL(/\/$/);
      await expect(current).toHaveText("Planner");
      await expect(current).toBeVisible({ visible: layout.currentLinkShown });
      const stayed = await page.evaluate((): unknown => Reflect.get(window, "__stayed"));
      expect(stayed).toBe(true);
    });
  });
}

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
