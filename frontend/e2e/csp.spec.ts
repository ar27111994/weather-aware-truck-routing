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
      // Where the blocked code ran is the part a failure needs: `blocked eval` alone does not say
      // which bundle (and so which dependency) tried to compile a string.
      const where =
        event.sourceFile === ""
          ? ""
          : ` at ${event.sourceFile}:${String(event.lineNumber)}:${String(event.columnNumber)}`;
      events.push(`${event.violatedDirective}: blocked ${event.blockedURI}${where}`);
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
 * injected hashes and never `'unsafe-inline'`; `style-src` is `'self'` plus the hashes of any
 * inline `<style>` and never `'unsafe-inline'`, while `style-src-attr` allows the style attributes
 * React and React Aria write (D-25). Without this the tests could pass against a server that sends
 * no policy at all, which is what `pnpm preview` is.
 */
function expectBuildPolicy(sent: readonly string[]): void {
  expect(sent, "the page was not served with a policy: use scripts/e2e-csp.sh").not.toEqual([]);
  for (const policy of sent) {
    const scriptSources = sourcesOf(policy, "script-src");
    expect(scriptSources).toContain("'self'");
    expect(scriptSources.some((source) => source.startsWith("'sha256-"))).toBe(true);
    expect(scriptSources).not.toContain("'unsafe-inline'");
    const styleSources = sourcesOf(policy, "style-src");
    expect(styleSources).toContain("'self'");
    expect(styleSources).not.toContain("'unsafe-inline'");
    expect(sourcesOf(policy, "style-src-attr")).toContain("'unsafe-inline'");
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

test.describe("the style policy (D-25)", () => {
  // What the policy does with the two ways of styling that a script can reach: an inline <style>
  // element, which only a hash can allow, and a style attribute, which `style-src-attr` allows
  // because React and React Aria write them (the position of a slider thumb, a popover).
  test("blocks an inline <style> element, allows a style attribute, and leaves the page styled", async ({
    page,
  }) => {
    const sent = await enforceBuiltPolicy(page);
    const violations = await watchViolations(page);

    await page.goto("/methodology");

    expectBuildPolicy(sent);
    expect(await violations(), "the page broke the policy while it loaded").toEqual([]);
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toBeVisible();
    // The stylesheet of the build is applied: its font is not the browser's default serif.
    expect(await heading.evaluate((node) => getComputedStyle(node).fontFamily)).toMatch(
      /overpass/i,
    );

    const applied = await page.evaluate(() => {
      const probe = document.createElement("p");
      probe.id = "csp-probe";
      probe.textContent = "probe";
      document.body.append(probe);

      const inlineStyle = document.createElement("style");
      inlineStyle.textContent = "#csp-probe { letter-spacing: 7px; }";
      document.head.append(inlineStyle);
      const fromElement = getComputedStyle(probe).letterSpacing;

      probe.setAttribute("style", "word-spacing: 9px");
      const fromAttribute = getComputedStyle(probe).wordSpacing;
      return { fromElement, fromAttribute };
    });

    expect(applied).toEqual({ fromElement: "normal", fromAttribute: "9px" });
    // The browser reports the blocked element after the script has finished.
    await expect
      .poll(async () => (await violations()).some((entry) => entry.startsWith("style-src")))
      .toBe(true);
    expect((await violations()).filter((entry) => entry.startsWith("style-src-attr"))).toEqual([]);
  });
});

test.describe("search engines (D-27)", () => {
  // /design stays public as the living style guide, and is kept out of results by the header, which
  // reaches crawlers that never run the page's JavaScript (the meta tag is only there after
  // hydration). Nothing else is noindex: the planner has to stay findable.
  test("are told to skip /design and everything under it, and nothing else", async ({
    request,
  }) => {
    for (const path of ["/design", "/design/anything"]) {
      const response = await request.get(path);
      expect(response.headers()["x-robots-tag"], path).toBe("noindex, nofollow");
    }
    for (const path of ["/", "/methodology"]) {
      const response = await request.get(path);
      expect(response.headers()["x-robots-tag"], path).toBeUndefined();
    }
  });
});

test.describe("/design/map (MapLibre under the policy, D-25)", () => {
  // The map is the one page that runs a web worker and fetches third-party tiles, glyphs and
  // sprites. Its worker is a same-origin asset, so `worker-src 'self'` (no blob:) must be enough;
  // a blocked worker or tile leaves the map without a style, and the test times out on it.
  test("loads the style, tiles, glyphs, sprites and the worker with nothing blocked", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const sent = await enforceBuiltPolicy(page);
    const violations = await watchViolations(page);

    await page.goto("/design/map");
    const map = page.getByTestId("map-canvas-container");
    await expect(map).toHaveAttribute("data-style-ready", "true", { timeout: 60_000 });
    await expect(map).toHaveAttribute("data-idle", "true", { timeout: 60_000 });

    expectBuildPolicy(sent);
    for (const policy of sent) expect(sourcesOf(policy, "worker-src")).toEqual(["'self'"]);
    expect(await violations(), "the browser blocked something the map needs").toEqual([]);
  });
});

test.describe("the iOS code path of React Aria's scroll lock (R3-01, D-25)", () => {
  // No engine in CI reports an iOS platform, so React Aria never takes its iOS branch here. On a
  // real iPhone or iPad (every iOS browser is WebKit), opening a modal overlay (a Dialog, a Select
  // or a DatePicker popover) prepends an inline <style> to <head>, and without its hash in
  // `style-src` the browser logs a policy violation. `shared/csp-runtime-styles.json` lists the
  // text and `inject-csp` adds the hash; `prevent-scroll-style.test.tsx` pins the text to the
  // library. This test runs the real thing: WebKit under the built policy, with the platform
  // that React Aria reads set to an iPhone before any page script runs.
  test.skip(({ browserName }) => browserName !== "webkit", "the iOS path is WebKit's");

  /** The hash `inject-csp` adds for the text in shared/csp-runtime-styles.json (written out). */
  const PREVENT_SCROLL_HASH = "'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='";

  const OVERLAYS = [
    {
      name: "Dialog",
      section: "Dialog",
      trigger: (page: Page) => page.getByRole("button", { name: "Clear recent searches" }),
      overlay: (page: Page) => page.getByRole("dialog"),
    },
    {
      name: "Select",
      section: "Select",
      trigger: (page: Page) => page.locator('button[aria-haspopup="listbox"]').first(),
      overlay: (page: Page) => page.getByRole("listbox"),
    },
    {
      name: "DatePicker",
      section: "DatePicker",
      trigger: (page: Page) => page.locator('button[aria-haspopup="dialog"]').first(),
      overlay: (page: Page) => page.getByRole("dialog"),
    },
  ] as const;

  /** Makes the page an iPhone for React Aria, which asks `navigator.platform` (and `userAgentData`). */
  async function spoofIPhone(page: Page): Promise<void> {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => "iPhone" });
      Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined });
    });
  }

  /** Whether React Aria has taken its iOS branch: it prepends the scroll-lock style. */
  async function scrollLockStyleWritten(page: Page): Promise<boolean> {
    return page.evaluate(() =>
      [...document.head.querySelectorAll("style")].some((element) =>
        element.textContent.includes("overscroll-behavior"),
      ),
    );
  }

  /** Two animation frames: the browser has reported what a style insertion broke by then. */
  async function settle(page: Page): Promise<void> {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              resolve();
            });
          });
        }),
    );
  }

  for (const { name, section, trigger, overlay } of OVERLAYS) {
    test(`opening a ${name} logs no violation, and the policy carries the hash`, async ({
      page,
    }) => {
      const sent = await enforceBuiltPolicy(page);
      const violations = await watchViolations(page);
      await spoofIPhone(page);

      await page.goto(`/design?section=${section}`);
      await expect(async () => {
        await trigger(page).click();
        await expect(overlay(page)).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: RESPONDS_WITHIN_MS });

      expectBuildPolicy(sent);
      for (const policy of sent) {
        expect(sourcesOf(policy, "style-src")).toContain(PREVENT_SCROLL_HASH);
      }
      // The proof that the iOS branch ran: without it a pass would say nothing.
      await expect.poll(() => scrollLockStyleWritten(page)).toBe(true);
      await settle(page);
      expect(await violations(), "the browser blocked the scroll-lock style").toEqual([]);

      await page.keyboard.press("Escape");
      await expect(overlay(page)).toBeHidden();
    });
  }

  test("is blocked when the hash is missing from the policy", async ({ page }) => {
    // The negative control: the same page and the same click, with the hash taken out.
    await enforceBuiltPolicy(page, (policy) => policy.replaceAll(` ${PREVENT_SCROLL_HASH}`, ""));
    const violations = await watchViolations(page);
    await spoofIPhone(page);

    await page.goto("/design?section=Dialog");
    await expect(async () => {
      await page.getByRole("button", { name: "Clear recent searches" }).click();
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: RESPONDS_WITHIN_MS });

    await expect.poll(() => scrollLockStyleWritten(page)).toBe(true);
    await expect
      .poll(async () => (await violations()).some((entry) => entry.startsWith("style-src")))
      .toBe(true);
  });
});
