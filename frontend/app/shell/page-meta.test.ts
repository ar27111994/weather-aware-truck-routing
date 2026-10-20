import { describe, expect, it } from "vitest";

import { pageMeta } from "./page-meta";

const BASE = { title: "Methodology", description: "How risk is scored.", path: "/methodology" };

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
    expect(pageMeta(BASE)).not.toContainEqual(expect.objectContaining({ name: "robots" }));
    expect(pageMeta({ ...BASE, noindex: true })).toContainEqual({
      name: "robots",
      content: "noindex, nofollow",
    });
  });
});
