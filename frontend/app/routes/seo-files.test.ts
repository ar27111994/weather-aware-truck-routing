import { afterEach, describe, expect, it, vi } from "vitest";

import { loader as llmsFull } from "./llms-full";
import { loader as llms } from "./llms";
import { loader as robots } from "./robots";

describe("the files written next to the pages at build time", () => {
  it.each([
    ["robots.txt", robots, "text/plain; charset=utf-8", "User-agent: *"],
    ["llms.txt", llms, "text/plain; charset=utf-8", "# Haulcast"],
    ["llms-full.txt", llmsFull, "text/plain; charset=utf-8", "## Risk thresholds"],
  ])("%s answers with its own type and its text", async (_name, loader, type, text) => {
    const response = loader();

    expect(response.headers.get("Content-Type")).toBe(type);
    expect(await response.text()).toContain(text);
  });
});

describe("the sitemap route (R4-15)", () => {
  /** The route as a build with this origin (or none) sees it: the origin is read when it loads. */
  async function sitemapLoaderFor(origin: string | undefined): Promise<() => Response> {
    vi.stubEnv("VITE_SITE_URL", origin);
    vi.resetModules();
    return (await import("./sitemap")).loader;
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("answers with the pages of the site once the build knows its origin", async () => {
    const response = (await sitemapLoaderFor("https://haulcast.example"))();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    const xml = await response.text();
    expect(xml).toContain("<loc>https://haulcast.example/methodology</loc>");
    expect(xml.match(/<url>/gu)?.length).toBeGreaterThanOrEqual(1);
  });

  it("answers with the same bytes on any day", async () => {
    const loader = await sitemapLoaderFor("https://haulcast.example");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T17:05:00Z"));
    const first = await loader().text();
    vi.setSystemTime(new Date("2026-10-22T09:30:00Z"));
    const second = await loader().text();

    expect(second).toBe(first);
  });

  it("answers 404, and never an empty urlset, when the build has no origin to list", async () => {
    const response = (await sitemapLoaderFor(undefined))();

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});
