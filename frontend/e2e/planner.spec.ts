import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { http } from "msw";

import { expect, test } from "./support/mock-api";
import { chooseTrip, openPlanner, tripAddress } from "./support/planner";

// The clock is pinned inside `openPlanner`; the language and the zone are pinned here.
test.use({ locale: "en-US", timezoneId: "America/Denver" });

const HEADLINE = /^Take Route [A-C]\.$/u;
const PLANS = "*/api/v1/plans";

/** Every axe violation as `rule: selector | selector`, so a failure says what to fix. */
async function axeViolations(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(" | ")}`,
  );
}

function planRequests(requests: readonly string[]): string[] {
  return requests.filter((request) => request.startsWith("POST /api/v1/plans"));
}

test.describe("the planner page", () => {
  test("opens on the empty state, with the form, room for the map and the footer", async ({
    page,
    backend,
  }) => {
    await openPlanner(page);

    await expect(
      page.getByRole("heading", { level: 1, name: "Haulcast route planner" }),
    ).toBeAttached();
    await expect(page.getByRole("region", { name: "Trip planner" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Route map" })).toBeVisible();
    await expect(page.getByText("Plan around the weather.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Plan routes" })).toBeEnabled();
    await expect(
      page
        .getByRole("region", { name: "Trip planner" })
        .getByRole("link", { name: "Design system" }),
    ).toHaveAttribute("href", "/design");
    // Opening the page asks for the scenarios (the Weather source list) and for nothing else.
    await expect.poll(() => backend.requests).toEqual(["GET /api/v1/scenarios"]);
  });

  test("plans a trip typed into the form and answers with the recommendation, the routes and the checkpoints", async ({
    page,
    backend,
  }) => {
    await openPlanner(page);
    await chooseTrip(page);

    await page.getByRole("button", { name: "Plan routes" }).click();

    await expect(page.getByText(HEADLINE)).toBeVisible();
    await expect(page.getByRole("grid", { name: "Routes" }).getByRole("row")).toHaveCount(3);
    await expect(
      page.getByRole("region", { name: /^Checkpoints for Route [A-C]$/u }),
    ).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Plan ready" })).toContainText(
      "3 routes found",
    );
    await expect(page).toHaveURL(/[?&]plan=pln_/u);
    expect(planRequests(backend.requests)).toHaveLength(1);
  });

  // React throws the whole prerendered tree away (and the head grows a second copy of the structured
  // data) when the browser's first render differs from the prerendered HTML in one text node. A real
  // browser is the only place to see it: Node and the browser format times with different ICU.
  test("hydrates the prerendered page without throwing it away", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });

    await openPlanner(page);

    expect(problems).toEqual([]);
    await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(1);
  });

  // The loading fallback is prerendered at `/`, and the browser draws it again on every page that
  // is not prerendered. If the two shells differ, React throws the page away and `<html>` loses the
  // `data-theme` the inline script set: a saved theme is forgotten on /design and on a wrong address.
  for (const address of ["/design", "/no-such-page"]) {
    test(`hydrates ${address}, which is not prerendered, and keeps the saved theme`, async ({
      page,
    }) => {
      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(error.message));
      await page.addInitScript(() => {
        window.localStorage.setItem("hc-theme", "dark");
      });

      await page.goto(address);

      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      expect(problems).toEqual([]);
    });
  }

  test("picks a place from the list with the keyboard alone", async ({ page }) => {
    await openPlanner(page);
    const destination = page.getByRole("combobox", { name: /^To/u });

    await destination.fill("denv");
    await expect(page.getByRole("option", { name: /Denver/u })).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await expect(destination).toHaveValue("Denver, Colorado, United States");
  });

  test("names what is missing instead of planning a trip that is not there", async ({
    page,
    backend,
  }) => {
    await openPlanner(page);

    await page.getByRole("button", { name: "Plan routes" }).click();

    await expect(page.getByRole("combobox", { name: /^From/u })).toHaveAccessibleDescription(
      /Choose a starting point from the list\./u,
    );
    await expect(page.getByRole("textbox", { name: /Load weight/u })).toHaveAccessibleDescription(
      /Enter the load weight in pounds\./u,
    );
    expect(planRequests(backend.requests)).toEqual([]);
  });

  test("reopens a plan from its address without planning it again", async ({ page, backend }) => {
    await openPlanner(page, tripAddress());
    await page.getByRole("button", { name: "Plan routes" }).click();
    await expect(page.getByText(HEADLINE)).toBeVisible();
    await expect(page).toHaveURL(/[?&]plan=pln_/u);
    const shared = page.url();
    const headline = await page.getByText(HEADLINE).innerText();

    await page.goto(shared);

    await expect(page.getByText(HEADLINE)).toHaveText(headline);
    await expect(page.getByRole("button", { name: "Edit trip" })).toBeVisible();
    expect(planRequests(backend.requests)).toHaveLength(1);
    expect(backend.requests.some((request) => request.startsWith("GET /api/v1/plans/pln_"))).toBe(
      true,
    );
  });

  test("keeps the checkpoint table in step with the route that is selected", async ({ page }) => {
    await openPlanner(page, tripAddress("mixed"));
    await page.getByRole("button", { name: "Plan routes" }).click();
    await expect(page.getByText(HEADLINE)).toBeVisible();
    const second = page.getByRole("grid", { name: "Routes" }).getByRole("row").nth(1);
    const letter = /^Route ([A-C])/u.exec((await second.getAttribute("aria-label")) ?? "")?.[1];
    expect(letter).toBeDefined();

    await second.click();

    await expect(second).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("region", { name: `Checkpoints for Route ${letter ?? ""}` }),
    ).toBeVisible();
  });

  test("says what went wrong when routing is down, and plans again on Try again", async ({
    page,
    backend,
  }) => {
    // A POST is never retried, so one failed answer is all it takes.
    backend.use(
      http.post(
        PLANS,
        () => backend.mocks.problemResponse(503, "routing_unavailable", "Routing is unavailable"),
        { once: true },
      ),
    );
    await openPlanner(page, tripAddress());

    await page.getByRole("button", { name: "Plan routes" }).click();

    await expect(page.getByRole("alert")).toContainText("Routing is unavailable");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText(HEADLINE)).toBeVisible();
  });

  test("copies the link of the plan and says so", async ({ page, context, browserName }) => {
    if (browserName === "chromium") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    }
    await openPlanner(page, tripAddress());
    await page.getByRole("button", { name: "Plan routes" }).click();
    await expect(page.getByText(HEADLINE)).toBeVisible();
    await expect(page).toHaveURL(/[?&]plan=pln_/u);

    await page.getByRole("button", { name: "Copy link" }).click();

    // Only Chromium lets a test read the clipboard; the others still show what happened.
    await expect(page.getByText(/Link copied|Couldn.t copy/u)).toBeVisible();
    if (browserName === "chromium") {
      await expect(page.getByText("Link copied")).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
    }
  });
});

test.describe("the layout", () => {
  test("puts the panel beside the map on a desktop", async ({ page, isMobile }) => {
    test.skip(isMobile, "the side layout starts at 1024 px; the phone projects get the sheet");
    await openPlanner(page);

    const panel = await page.getByRole("region", { name: "Trip planner" }).boundingBox();
    const map = await page.getByRole("region", { name: "Route map" }).boundingBox();

    if (panel === null || map === null) throw new Error("the panel and the map must both be drawn");
    expect(panel.width).toBeGreaterThanOrEqual(400);
    expect(panel.width).toBeLessThanOrEqual(440);
    expect(map.x).toBeGreaterThanOrEqual(panel.x + panel.width - 1);
    expect(map.width).toBeGreaterThan(panel.width);
  });

  test("puts the panel in a sheet over the map on a phone, and the keyboard moves the sheet", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "the sheet is for screens under 1024 px");
    await openPlanner(page);
    const sheet = page.getByRole("region", { name: "Trip planner" });
    const handle = sheet.getByRole("button", { name: /^(Expand|Collapse) panel$/u });
    const map = await page.getByRole("region", { name: "Route map" }).boundingBox();
    const viewport = page.viewportSize();
    if (map === null || viewport === null) throw new Error("the map and the viewport must exist");
    expect(map.width).toBeGreaterThanOrEqual(viewport.width - 1);

    await expect(sheet).toHaveAttribute("data-snap", "half");
    await handle.focus();
    await page.keyboard.press("End");
    await expect(sheet).toHaveAttribute("data-snap", "full");
    await page.keyboard.press("Home");
    await expect(sheet).toHaveAttribute("data-snap", "peek");
    await expect(handle).toHaveAttribute("aria-expanded", "false");
  });
});

test.describe("accessibility", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    test.describe(`${colorScheme} theme`, () => {
      test.use({ colorScheme });

      test("has no axe violations on the empty planner", async ({ page }) => {
        await openPlanner(page);

        expect(await axeViolations(page)).toEqual([]);
      });

      test("has no axe violations on a plan", async ({ page }) => {
        await openPlanner(page, tripAddress("mixed"));
        await page.getByRole("button", { name: "Plan routes" }).click();
        await expect(page.getByText(HEADLINE)).toBeVisible();

        expect(await axeViolations(page)).toEqual([]);
      });
    });
  }
});
