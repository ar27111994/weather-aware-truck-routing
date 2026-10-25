import { afterEach, describe, expect, it, vi } from "vitest";

import { pageMeta } from "./page-meta";

const BASE = { title: "Methodology", description: "How risk is scored.", path: "/methodology" };

/** The module as a build with this `VITE_SITE_URL` (or none) loads it: the origin is read at load. */
async function pageMetaModuleFor(value: string | undefined) {
  vi.stubEnv("VITE_SITE_URL", value);
  vi.resetModules();
  return import("./page-meta");
}

afterEach(() => {
  vi.resetModules();
});

describe("pageMeta", () => {
  it("always has a title, a description and the Open Graph and Twitter basics", () => {
    const tags = pageMeta(BASE);

    expect(tags).toContainEqual({ title: "Methodology" });
    expect(tags).toContainEqual({ name: "description", content: "How risk is scored." });
    expect(tags).toContainEqual({ property: "og:type", content: "website" });
    expect(tags).toContainEqual({ property: "og:site_name", content: "Haulcast" });
    expect(tags).toContainEqual({ property: "og:title", content: "Methodology" });
    expect(tags).toContainEqual({ property: "og:description", content: "How risk is scored." });
    expect(tags).toContainEqual({ name: "twitter:card", content: "summary_large_image" });
    expect(tags).toContainEqual({ name: "twitter:title", content: "Methodology" });
    expect(tags).toContainEqual({ name: "twitter:description", content: "How risk is scored." });
  });

  it("adds the canonical link, og:url and the 1200 by 630 image once a site origin is known", () => {
    const tags = pageMeta({ ...BASE, siteUrl: "https://haulcast.example" });

    expect(tags).toContainEqual({
      tagName: "link",
      rel: "canonical",
      href: "https://haulcast.example/methodology",
    });
    expect(tags).toContainEqual({
      property: "og:url",
      content: "https://haulcast.example/methodology",
    });
    expect(tags).toContainEqual({
      property: "og:image",
      content: "https://haulcast.example/og.png",
    });
    expect(tags).toContainEqual({ property: "og:image:width", content: "1200" });
    expect(tags).toContainEqual({ property: "og:image:height", content: "630" });
    expect(tags).toContainEqual({
      name: "twitter:image",
      content: "https://haulcast.example/og.png",
    });
  });

  it("leaves every absolute-URL tag out rather than guessing an origin", () => {
    const tags = pageMeta({ ...BASE, siteUrl: undefined });

    expect(JSON.stringify(tags)).not.toMatch(/canonical|og:url|og:image|twitter:image/);
  });

  it("resolves the home path against the origin", () => {
    const tags = pageMeta({ ...BASE, path: "/", siteUrl: "https://haulcast.example" });

    expect(tags).toContainEqual({ property: "og:url", content: "https://haulcast.example/" });
  });

  it("only asks search engines to stay away when told to", () => {
    const hidden = { title: BASE.title, description: BASE.description, noindex: true } as const;

    expect(pageMeta(BASE)).not.toContainEqual(expect.objectContaining({ name: "robots" }));
    expect(pageMeta(hidden)).toContainEqual({ name: "robots", content: "noindex, nofollow" });
  });

  it("gives a page that stays out of search results no canonical link and no og:url", () => {
    const tags = pageMeta({
      title: BASE.title,
      description: BASE.description,
      noindex: true,
      siteUrl: "https://haulcast.example",
    });

    expect(JSON.stringify(tags)).not.toMatch(/canonical|og:url/);
    expect(tags).toContainEqual({
      property: "og:image",
      content: "https://haulcast.example/og.png",
    });
  });

  it.each(["", "   "])("treats the blank site origin %j as not set", (siteUrl) => {
    const tags = pageMeta({ ...BASE, siteUrl });

    expect(JSON.stringify(tags)).not.toMatch(/canonical|og:url|og:image|twitter:image/);
  });

  it.each(["haulcast.example", "localhost:3000", "/just/a/path"])(
    "fails loudly when the site origin %j is not an absolute URL",
    (siteUrl) => {
      expect(() => pageMeta({ ...BASE, siteUrl })).toThrow(
        `VITE_SITE_URL must be an absolute URL such as https://haulcast.example, got "${siteUrl}"`,
      );
    },
  );
});

describe("SITE_URL, the origin that the pages, their structured data and the crawler files share", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("is not set when VITE_SITE_URL is %s (RT-F1)", async (_how, value) => {
    const { SITE_URL, pageMeta: tagsFor } = await pageMetaModuleFor(value);

    expect(SITE_URL).toBeUndefined();
    expect(JSON.stringify(tagsFor(BASE))).not.toMatch(/canonical|og:url|og:image|twitter:image/);
  });

  it("is the origin without the whitespace around it when VITE_SITE_URL is an absolute URL", async () => {
    const { SITE_URL, pageMeta: tagsFor } = await pageMetaModuleFor(" https://haulcast.example ");

    expect(SITE_URL).toBe("https://haulcast.example");
    expect(tagsFor(BASE)).toContainEqual({
      tagName: "link",
      rel: "canonical",
      href: "https://haulcast.example/methodology",
    });
  });

  it("fails the load, naming the value, when VITE_SITE_URL is not an absolute URL (RT-F1)", async () => {
    await expect(pageMetaModuleFor("haulcast.example")).rejects.toThrow(
      'VITE_SITE_URL must be an absolute URL such as https://haulcast.example, got "haulcast.example"',
    );
  });
});
