import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * The pages under the Content-Security-Policy that production serves.
 *
 * `scripts/vercel_output.py inject-csp` hashes every executable inline script of the built HTML
 * into `script-src` after `vercel build` (nothing is committed: the hashes change with every
 * build), and `scripts/serve-vercel-output.mjs` serves that output with those headers the way
 * Vercel does. `scripts/e2e-csp.sh` ties the two together and runs this file; CI runs it in the
 * `vercel` job, the one job that builds `.vercel/output`.
 *
 * A hash-only `script-src` that misses a script stops the page from hydrating, which neither a
 * unit test nor the plain preview server (it sends no policy) can see. These tests load the real
 * pages in the real engines and let the browser enforce the policy. They run in the `csp-*`
 * projects and never against the preview server.
 */

/** A page counts as hydrated once a control that only React can answer has answered. */
const RESPONDS_WITHIN_MS = 10_000;

const PAGES = [
  { path: "/", how: "prerendered" },
  { path: "/methodology", how: "prerendered" },
  { path: "/design", how: "rendered in the browser behind the SPA fallback" },
] as const;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Makes the browser enforce the policy the build produced on every document it loads, and returns
 * the policies the server actually sent (so a test can check that they were the build's).
 *
 * One directive is dropped: `upgrade-insecure-requests` is about transport, not scripts, and
 * WebKit (unlike Chromium and Firefox) applies it to 127.0.0.1 as well, which sends every asset
 * request to https://127.0.0.1, where nothing listens. Everything else reaches the browser as
 * built. `adjust` changes the policy further, for the negative control.
 */
async function enforceBuiltPolicy(
  page: Page,
  adjust: (policy: string) => string = (policy) => policy,
): Promise<string[]> {
  const sent: string[] = [];
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const policy = response.headers()["content-security-policy"] ?? "";
    sent.push(policy);
    const enforced = policy
      .split(";")
      .map((directive) => directive.trim())
      .filter((directive) => directive !== "" && directive !== "upgrade-insecure-requests")
      .join("; ");
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": adjust(enforced) },
    });
  });
  return sent;
}

/**
 * Starts listening for everything the browser reports about a blocked resource: the
 * `securitypolicyviolation` event (the same in every engine) and the console line (worded
 * differently by each). Returns a function that lists what has been reported so far.
 */
async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
  const logged: string[] = [];
  page.on("console", (message) => {
    // Chromium and WebKit write "Content Security Policy", Firefox "Content-Security-Policy".
    if (/content[ -]security[ -]policy/i.test(message.text())) {
      logged.push(message.text());
    }
  });
  await page.addInitScript(() => {
    const events: string[] = [];
    Reflect.set(window, "__cspViolations", events);
    document.addEventListener("securitypolicyviolation", (event) => {
      events.push(`${event.violatedDirective}: blocked ${event.blockedURI}`);
    });
  });
  return async () => {
    const events = await page.evaluate((): unknown => Reflect.get(window, "__cspViolations"));
    return [...(isStringArray(events) ? events : []), ...logged];
  };
}

/** The sources of one directive of a policy, such as `script-src`; empty when it is missing. */
function sourcesOf(policy: string, directive: string): string[] {
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name === directive) {
      return sources;
    }
  }
  return [];
}

/**
 * Fails unless the server sent the policy the build produces: `script-src` is `'self'` plus the
 * injected hashes and never `'unsafe-inline'`. Without this the tests could pass against a server
 * that sends no policy at all, which is what `pnpm preview` is.
 */
function expectBuildPolicy(sent: readonly string[]): void {
  expect(sent, "the page was not served with a policy: use scripts/e2e-csp.sh").not.toEqual([]);
  for (const policy of sent) {
    const scriptSources = sourcesOf(policy, "script-src");
    expect(scriptSources).toContain("'self'");
    expect(scriptSources.some((source) => source.startsWith("'sha256-"))).toBe(true);
    expect(scriptSources).not.toContain("'unsafe-inline'");
  }
}

for (const { path, how } of PAGES) {
  test.describe(`${path} (${how})`, () => {
    test("loads and hydrates under the policy the build produced", async ({ page }) => {
      const sent = await enforceBuiltPolicy(page);
      const violations = await watchViolations(page);

      await page.goto(path);

      expectBuildPolicy(sent);
      expect(await violations(), "the browser blocked something while the page loaded").toEqual([]);

      // Hydration is asynchronous, so the click is retried until the page answers; a page whose
      // scripts were blocked never answers and fails here. The header's toggle is the one to use:
      // the kitchen sink shows more of them.
      const toggle = page.getByRole("banner").getByRole("radio", { name: "Dark theme" });
      await expect(async () => {
        await toggle.click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark", {
          timeout: 1_000,
        });
      }).toPass({ timeout: RESPONDS_WITHIN_MS });
      expect(await violations(), "the browser blocked something after the page loaded").toEqual([]);
    });
  });
}

test.describe("the harness itself", () => {
  // Proof that a pass above means something: take the hashes away, which leaves the policy that is
  // committed in vercel.json (`script-src 'self'`), and the same page is blocked.
  test("blocks the page when the build's hashes are missing from the policy", async ({ page }) => {
    await enforceBuiltPolicy(page, (policy) => policy.replace(/ 'sha256-[^']*'/g, ""));
    const violations = await watchViolations(page);

    await page.goto("/");

    expect(await violations()).not.toEqual([]);
    // The theme script is the first inline script in <head>; blocked, it never sets the attribute.
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  });
});
