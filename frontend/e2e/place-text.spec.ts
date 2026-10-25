import type { Request } from "@playwright/test";

import { expect, test } from "./support/mock-api";
import { openPlanner, tripAddress } from "./support/planner";

// D-56: a place field never deletes text that a visitor typed or that a link restored. Leaving a
// field only closes its list. The tests open the real prerendered page, wait until the browser has
// taken it over, and walk the keyboard through the fields the way a visitor does.
test.use({ locale: "en-US", timezoneId: "America/Denver" });

const FROM = /^From/u;
const TO = /^To/u;
const SALT_LAKE_CITY = "Salt Lake City, Utah, United States";
const DENVER = "Denver, Colorado, United States";
const REQUIRED = /Choose a starting point from the list\./u;
const HEADLINE = /^Take Route [A-C]\.$/u;

function isPlanRequest(request: Request): boolean {
  return request.method() === "POST" && request.url().endsWith("/api/v1/plans");
}

function requestsTo(requests: readonly string[], path: string): string[] {
  return requests.filter((request) => request.startsWith(`GET ${path}`));
}

test.describe("a place field keeps its text when focus leaves", () => {
  test("keeps the places that a shared link restored, and Plan routes plans that trip", async ({
    page,
    backend,
  }) => {
    await openPlanner(page, tripAddress());
    const from = page.getByRole("combobox", { name: FROM });
    const to = page.getByRole("combobox", { name: TO });
    await expect(from).toHaveValue(SALT_LAKE_CITY);
    await expect(to).toHaveValue(DENVER);

    // Into From and out of it with the keyboard, then into To and out of it.
    await from.click();
    await page.keyboard.press("Tab");
    await expect(from).not.toBeFocused();
    await to.click();
    await page.keyboard.press("Tab");
    await expect(to).not.toBeFocused();

    await expect(from).toHaveValue(SALT_LAKE_CITY);
    await expect(to).toHaveValue(DENVER);
    await expect(from).toHaveAttribute("aria-expanded", "false");
    await expect(to).toHaveAttribute("aria-expanded", "false");
    // The restored places are the answer: nobody asked the geocoder about them.
    expect(requestsTo(backend.requests, "/api/v1/geocode")).toEqual([]);

    const planned = page.waitForRequest(isPlanRequest);
    await page.getByRole("button", { name: "Plan routes" }).click();

    expect((await planned).postDataJSON()).toMatchObject({
      origin: { lat: 40.7608, lon: -111.891, label: SALT_LAKE_CITY },
      destination: { lat: 39.7392, lon: -104.9903, label: DENVER },
    });
    await expect(page.getByText(HEADLINE)).toBeVisible();
  });

  test("keeps what was typed and never chosen, and Plan routes names what is missing", async ({
    page,
    backend,
  }) => {
    await openPlanner(page);
    const from = page.getByRole("combobox", { name: FROM });

    await from.fill("salt");
    await expect(page.getByRole("option", { name: /Salt Lake City/u })).toBeVisible();
    await page.keyboard.press("Tab");

    await expect(from).not.toBeFocused();
    await expect(from).toHaveValue("salt");
    await expect(from).toHaveAttribute("aria-expanded", "false");

    await page.getByRole("button", { name: "Plan routes" }).click();

    await expect(from).toHaveValue("salt");
    await expect(from).toHaveAccessibleDescription(REQUIRED);
    expect(backend.requests.filter((request) => request.startsWith("POST /api/v1/plans"))).toEqual(
      [],
    );
  });
});
