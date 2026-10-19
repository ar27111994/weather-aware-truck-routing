import { expect, test } from "@playwright/test";

test("home page renders the product heading", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "Haulcast" })).toBeVisible();
});

test("methodology page is prerendered and reachable", async ({ page }) => {
  await page.goto("/methodology");

  await expect(page.getByRole("heading", { level: 1, name: "Methodology" })).toBeVisible();
});
