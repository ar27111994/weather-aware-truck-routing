import { describe, expect, it } from "vitest";

import { AI_CRAWLERS, SITEMAP_PATHS, llmsFullTxt, llmsTxt, robotsTxt, sitemapXml } from "./files";

const ORIGIN = "https://haulcast.example";

describe("robotsTxt", () => {
  it("lets every crawler read the site and keeps them off the API", () => {
    const robots = robotsTxt(ORIGIN);

    expect(robots).toContain("User-agent: *\nAllow: /\nDisallow: /api/");
    expect(robots).not.toMatch(/Disallow: \/(design)?$/mu);
  });

  it("welcomes each AI crawler by name", () => {
    const robots = robotsTxt(ORIGIN);

    for (const crawler of AI_CRAWLERS) {
      expect(robots).toContain(`User-agent: ${crawler}\nAllow: /\nDisallow: /api/`);
    }
  });

  it("names the sitemap with an absolute address", () => {
    expect(robotsTxt(ORIGIN)).toContain("\nSitemap: https://haulcast.example/sitemap.xml\n");
  });

  it("names no sitemap when the build does not know the address of the site", () => {
    expect(robotsTxt(undefined)).not.toContain("Sitemap:");
    expect(robotsTxt(undefined).endsWith("\n")).toBe(true);
  });
});

describe("sitemapXml", () => {
  const builtAt = new Date("2026-10-21T17:05:00Z");

  it("lists the planner and the methodology, each with the day of the build", () => {
    const xml = sitemapXml(ORIGIN, builtAt);

    expect(
      xml.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ),
    ).toBe(true);
    expect(xml).toContain(
      "<loc>https://haulcast.example/</loc>\n    <lastmod>2026-10-21</lastmod>",
    );
    expect(xml).toContain("<loc>https://haulcast.example/methodology</loc>");
    expect(xml.match(/<url>/gu)).toHaveLength(SITEMAP_PATHS.length);
  });

  it("leaves out the style guide (D-27)", () => {
    expect(sitemapXml(ORIGIN, builtAt)).not.toContain("/design");
  });

  it("lists nothing, rather than guess, when the build does not know the address of the site", () => {
    const xml = sitemapXml(undefined, builtAt);

    expect(xml).not.toContain("<url>");
    expect(xml).toContain("</urlset>");
  });
});

describe("llmsTxt", () => {
  it("is a title, a summary and the pages worth reading, with absolute addresses", () => {
    const llms = llmsTxt(ORIGIN);

    expect(llms.startsWith("# Haulcast\n\n> Compare three truck routes")).toBe(true);
    expect(llms).toContain("## Pages");
    expect(llms).toContain("- [Planner](https://haulcast.example/): ");
    expect(llms).toContain("- [Methodology](https://haulcast.example/methodology): ");
    expect(llms).toContain("- [llms-full.txt](https://haulcast.example/llms-full.txt): ");
    expect(llms).toContain("(https://github.com/ar27111994/weather-aware-truck-routing)");
    expect(llms).not.toContain("/design");
  });

  it("falls back to site paths without an origin", () => {
    expect(llmsTxt(undefined)).toContain("- [Methodology](/methodology): ");
  });
});

describe("llmsFullTxt", () => {
  it("carries the whole methodology in Markdown", () => {
    const full = llmsFullTxt(ORIGIN);

    expect(
      full.startsWith(
        "# Haulcast: How Haulcast scores weather risk\n\n> Compare three truck routes",
      ),
    ).toBe(true);
    expect(full).toContain("Page: https://haulcast.example/methodology");
    expect(full).toContain("## Risk thresholds");
    expect(full).toContain("### No Travel ranks before Severe");
    expect(full.endsWith("\n")).toBe(true);
  });

  it("does not carry the style guide either", () => {
    expect(llmsFullTxt(ORIGIN)).not.toContain("/design");
  });
});
