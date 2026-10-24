// @vitest-environment node
// `buildSiteOrigin` reads the build's environment through Vite, which cannot load under jsdom
// (esbuild refuses jsdom's TextEncoder), and nothing here needs a DOM.
import { describe, expect, it, vi } from "vitest";

import { buildSiteOrigin, prerenderPaths } from "./prerender";

describe("buildSiteOrigin", () => {
  it("is the origin the build was given, the one Vite hands the app", () => {
    vi.stubEnv("VITE_SITE_URL", "https://haulcast.example");

    expect(buildSiteOrigin()).toBe("https://haulcast.example");
  });

  it("is undefined when the build was given none", () => {
    vi.stubEnv("VITE_SITE_URL", undefined);

    expect(buildSiteOrigin()).toBeUndefined();
  });
});

describe("prerenderPaths", () => {
  it("writes both pages and every crawler file out when the build knows the site's origin", () => {
    expect(prerenderPaths("https://haulcast.example")).toEqual([
      "/",
      "/methodology",
      "/robots.txt",
      "/sitemap.xml",
      "/llms.txt",
      "/llms-full.txt",
    ]);
  });

  it("leaves the sitemap out, and nothing else, when it does not (R4-15)", () => {
    // A sitemap lists absolute addresses: with no origin it would be an empty urlset, which the
    // sitemap schema does not accept.
    expect(prerenderPaths(undefined)).toEqual([
      "/",
      "/methodology",
      "/robots.txt",
      "/llms.txt",
      "/llms-full.txt",
    ]);
  });
});
