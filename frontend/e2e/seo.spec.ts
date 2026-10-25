import { expect, test } from "@playwright/test";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

// The site's origin as the build under test was given it (`VITE_SITE_URL`). Without one the pages
// leave out every absolute address instead of guessing, and the build writes no sitemap.
const CONFIGURED_ORIGIN = process.env["VITE_SITE_URL"]?.trim();
const ORIGIN = CONFIGURED_ORIGIN === "" ? undefined : CONFIGURED_ORIGIN;

interface Linked {
  readonly "@type": string;
  readonly mainEntity?: readonly unknown[];
}

async function structuredData(page: Page): Promise<Linked[]> {
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  return blocks.map((block) => JSON.parse(block) as Linked);
}

async function textOf(
  request: APIRequestContext,
  path: string,
): Promise<{ body: string; type: string }> {
  const response = await request.get(path);
  expect(response.status(), path).toBe(200);
  return { body: await response.text(), type: response.headers()["content-type"] ?? "" };
}

test.describe("what search engines and AI assistants read", () => {
  for (const [path, title] of [
    ["/", "Haulcast: weather-aware truck route planner"],
    ["/methodology", "How Haulcast scores weather risk"],
  ] as const) {
    test(`${path} names itself for search results and for sharing`, async ({ page }) => {
      await page.goto(path);

      await expect(page).toHaveTitle(title);
      const meta = (selector: string): Locator => page.locator(selector);
      await expect(meta('meta[name="description"]')).toHaveAttribute("content", /.{60,}/u);
      await expect(meta('meta[property="og:title"]')).toHaveAttribute("content", title);
      await expect(meta('meta[property="og:type"]')).toHaveAttribute("content", "website");
      await expect(meta('meta[name="twitter:card"]')).toHaveAttribute(
        "content",
        "summary_large_image",
      );
      await expect(meta('meta[name="robots"]')).toHaveCount(0);
      const canonical = meta('link[rel="canonical"]');
      if (ORIGIN === undefined) {
        await expect(canonical).toHaveCount(0);
      } else {
        await expect(canonical).toHaveAttribute("href", new URL(path, ORIGIN).href);
        await expect(meta('meta[property="og:image"]')).toHaveAttribute(
          "content",
          new URL("/og.png", ORIGIN).href,
        );
      }
    });
  }

  test("/ describes the app as a WebApplication", async ({ page }) => {
    await page.goto("/");

    expect((await structuredData(page)).map((block) => block["@type"])).toEqual(["WebApplication"]);
  });

  test("/methodology is a TechArticle with a FAQPage that has one question per question on the page", async ({
    page,
  }) => {
    await page.goto("/methodology");

    const blocks = await structuredData(page);

    expect(blocks.map((block) => block["@type"]).sort()).toEqual(["FAQPage", "TechArticle"]);
    const questions = await page
      .getByRole("region", { name: "Common questions" })
      .getByRole("heading", { level: 3 })
      .count();
    expect(questions).toBeGreaterThan(0);
    expect(blocks.find((block) => block["@type"] === "FAQPage")?.mainEntity).toHaveLength(
      questions,
    );
  });

  test("serves robots.txt that welcomes crawlers to the pages and keeps them out of the API", async ({
    request,
  }) => {
    const { body, type } = await textOf(request, "/robots.txt");

    expect(type).toMatch(/^text\/plain/u);
    for (const agent of ["*", "GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"]) {
      expect(body).toContain(`User-agent: ${agent}\nAllow: /\nDisallow: /api/`);
    }
    expect(body).not.toContain("/design");
    expect(body.includes("Sitemap:")).toBe(ORIGIN !== undefined);
  });

  test("serves a sitemap that lists the two pages and not the style guide, or none without an origin", async ({
    request,
  }) => {
    if (ORIGIN === undefined) {
      // A sitemap lists absolute addresses, so a build with no origin writes none (R4-15). A
      // file name with a dot never gets the app shell, so its absence is a plain 404.
      expect((await request.get("/sitemap.xml")).status()).toBe(404);
      return;
    }
    const { body, type } = await textOf(request, "/sitemap.xml");

    expect(type).toMatch(/xml/u);
    expect(body).not.toContain("/design");
    expect(body).not.toContain("<lastmod>");
    const listed = [...body.matchAll(/<loc>([^<]+)<\/loc>/gu)].map((match) => match[1]);
    expect(listed).toEqual([new URL("/", ORIGIN).href, new URL("/methodology", ORIGIN).href]);
  });

  test("serves llms.txt and the full methodology as Markdown for AI assistants", async ({
    request,
  }) => {
    const short = await textOf(request, "/llms.txt");
    const full = await textOf(request, "/llms-full.txt");

    expect(short.body).toMatch(/^# Haulcast\n/u);
    expect(short.body).toContain("[Methodology]");
    expect(short.body).toContain("llms-full.txt");
    expect(full.body).toMatch(/^# Haulcast: How Haulcast scores weather risk\n/u);
    expect(full.body).toMatch(/\| Wind \(mph\) \|/u);
    expect(short.body + full.body).not.toContain("/design");
  });

  test("ships the manifest, the icons and a 1200 by 630 share image", async ({ request }) => {
    const manifest = JSON.parse((await textOf(request, "/manifest.webmanifest")).body) as {
      readonly name: string;
      readonly icons: readonly { readonly src: string; readonly sizes: string }[];
    };

    expect(manifest.name).toBe("Haulcast");
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    for (const path of [
      "/favicon.svg",
      "/favicon-32.png",
      "/apple-touch-icon.png",
      ...manifest.icons.map((icon) => icon.src),
    ]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      expect(response.headers()["content-type"], path).toMatch(/^image\//u);
    }
    const card = await (await request.get("/og.png")).body();
    expect({ width: card.readUInt32BE(16), height: card.readUInt32BE(20) }).toEqual({
      width: 1200,
      height: 630,
    });
  });

  test("keeps the style guide out of search results", async ({ page }) => {
    await page.goto("/design");

    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/u);
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  });
});
