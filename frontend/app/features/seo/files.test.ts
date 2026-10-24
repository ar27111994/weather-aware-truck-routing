import { describe, expect, it, vi } from "vitest";

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
  const parsed = (xml: string): Document => new DOMParser().parseFromString(xml, "application/xml");

  it("is a valid sitemap: a urlset with at least one url, each a loc and nothing else", () => {
    const document = parsed(sitemapXml(ORIGIN));

    expect(document.querySelector("parsererror")).toBeNull();
    const urlset = document.documentElement;
    expect(urlset.localName).toBe("urlset");
    expect(urlset.namespaceURI).toBe("http://www.sitemaps.org/schemas/sitemap/0.9");
    const urls = [...urlset.children];
    // The sitemap schema needs at least one url; a sitemap function that can have none is wrong.
    expect(urls.length).toBeGreaterThanOrEqual(1);
    for (const url of urls) {
      expect(url.localName).toBe("url");
      expect([...url.children].map((child) => child.localName)).toEqual(["loc"]);
    }
  });

  it("lists the planner and the methodology, by absolute address", () => {
    const xml = sitemapXml(ORIGIN);

    expect(
      xml.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ),
    ).toBe(true);
    expect(xml).toContain("<loc>https://haulcast.example/</loc>");
    expect(xml).toContain("<loc>https://haulcast.example/methodology</loc>");
    expect(xml.match(/<url>/gu)).toHaveLength(SITEMAP_PATHS.length);
    expect(xml.endsWith("</urlset>\n")).toBe(true);
  });

  it("leaves out the style guide (D-27)", () => {
    expect(sitemapXml(ORIGIN)).not.toContain("/design");
  });

  it("states no lastmod, so the same sources give the same bytes on every day (R4-15)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-21T17:05:00Z"));
      const first = sitemapXml(ORIGIN);
      vi.setSystemTime(new Date("2026-10-22T09:30:00Z"));
      const second = sitemapXml(ORIGIN);

      expect(second).toBe(first);
      expect(first).not.toContain("lastmod");
    } finally {
      vi.useRealTimers();
    }
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
