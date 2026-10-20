import { expect, test } from "@playwright/test";

// Every test tagged @smoke also runs against the deployed site after each deployment
// (`E2E_BASE_URL=<url> pnpm e2e --grep @smoke`, see .github/workflows/deploy.yml).

// A protected Vercel preview answers 401 until the request carries the automation bypass secret.
// Priming the context once with the bypass header sets a cookie, so the browser's later requests
// (including third-party ones, which must never see the secret) need no header at all.
test.beforeEach(async ({ context, baseURL }) => {
  const secret = process.env["E2E_BYPASS_SECRET"];
  if (secret === undefined || secret === "" || baseURL === undefined) {
    return;
  }
  const response = await context.request.get(baseURL, {
    headers: { "x-vercel-protection-bypass": secret, "x-vercel-set-bypass-cookie": "true" },
  });
  expect(response.ok()).toBe(true);
});

test("home page renders the product heading @smoke", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "Haulcast" })).toBeVisible();
});

test("methodology page is prerendered and reachable @smoke", async ({ page }) => {
  await page.goto("/methodology");

  await expect(page.getByRole("heading", { level: 1, name: "Methodology" })).toBeVisible();
});

// The strict CSP blocks any inline script it has no hash for, which would stop hydration. Browsers
// log a violation to the console, so a clean console proves the deployed headers fit the pages.
test("pages load without Content-Security-Policy violations @smoke", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) {
      violations.push(message.text());
    }
  });

  for (const path of ["/", "/methodology"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }

  expect(violations).toEqual([]);
});
