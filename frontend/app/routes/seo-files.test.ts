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

/**
 * The four crawler files, each by its route: what it holds for a site whose origin the build knows
 * (`haulcast.example`) and for a site whose origin it does not. A route reads the origin when it
 * loads, so each test sets `VITE_SITE_URL` first and loads the route afresh.
 */
const CRAWLER_FILES = [
  {
    name: "robots.txt",
    load: () => import("./robots"),
    withOrigin: { status: 200, has: ["\nSitemap: https://haulcast.example/sitemap.xml\n"] },
    withoutOrigin: { status: 200, has: ["User-agent: *\nAllow: /"], lacks: ["Sitemap:"] },
  },
  {
    name: "llms.txt",
    load: () => import("./llms"),
    withOrigin: {
      status: 200,
      has: [
        "- [Planner](https://haulcast.example/): ",
        "- [Methodology](https://haulcast.example/methodology): ",
        "- [llms-full.txt](https://haulcast.example/llms-full.txt): ",
      ],
    },
    withoutOrigin: {
      status: 200,
      has: [
        "- [Planner](/): ",
        "- [Methodology](/methodology): ",
        "- [llms-full.txt](/llms-full.txt): ",
      ],
      lacks: ["haulcast.example"],
    },
  },
  {
    name: "llms-full.txt",
    load: () => import("./llms-full"),
    withOrigin: { status: 200, has: ["\nPage: https://haulcast.example/methodology\n"] },
    withoutOrigin: { status: 200, has: ["\nPage: /methodology\n"], lacks: ["haulcast.example"] },
  },
  {
    name: "sitemap.xml",
    load: () => import("./sitemap"),
    withOrigin: { status: 200, has: ["<loc>https://haulcast.example/methodology</loc>"] },
    withoutOrigin: { status: 404, has: [], lacks: ["<urlset", "<url>"] },
  },
] as const;

describe("the crawler files of a build that has no origin to name (RT-F1)", () => {
  afterEach(() => {
    vi.resetModules();
  });

  // A variable that is set but empty is the usual way to have no origin: a `VITE_SITE_URL=` line in
  // a .env file, or an empty variable in a hosting dashboard. It means the same as no variable.
  describe.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", " \t "],
  ])("when VITE_SITE_URL is %s", (_how, value) => {
    it.each(CRAWLER_FILES)("$name holds site paths and no absolute address", async (file) => {
      vi.stubEnv("VITE_SITE_URL", value);
      vi.resetModules();

      const response = (await file.load()).loader();

      expect(response.status).toBe(file.withoutOrigin.status);
      const text = await response.text();
      for (const part of file.withoutOrigin.has) {
        expect(text).toContain(part);
      }
      for (const part of file.withoutOrigin.lacks) {
        expect(text).not.toContain(part);
      }
    });
  });
});

describe("the crawler files of a build that knows the origin (RT-F1)", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it.each(CRAWLER_FILES)(
    "$name names absolute addresses, from the origin without the whitespace around it",
    async (file) => {
      vi.stubEnv("VITE_SITE_URL", " https://haulcast.example ");
      vi.resetModules();

      const response = (await file.load()).loader();

      expect(response.status).toBe(file.withOrigin.status);
      const text = await response.text();
      for (const part of file.withOrigin.has) {
        expect(text).toContain(part);
      }
    },
  );

  it.each(CRAWLER_FILES)(
    "$name cannot be loaded, and the build says why, when the origin is not an absolute URL",
    async (file) => {
      vi.stubEnv("VITE_SITE_URL", "haulcast.example");
      vi.resetModules();

      await expect(file.load()).rejects.toThrow(
        'VITE_SITE_URL must be an absolute URL such as https://haulcast.example, got "haulcast.example"',
      );
    },
  );
});
