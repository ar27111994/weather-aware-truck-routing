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

  it.each([
    ["empty", ""],
    ["blank", "   "],
  ])("is undefined, not a string, when the variable is set but %s (RT-F1)", (_how, value) => {
    // An empty variable (`VITE_SITE_URL=` in a .env file, an empty one in a hosting dashboard) is
    // no origin, as it is for the page tags: a string here would make the build write a sitemap.
    vi.stubEnv("VITE_SITE_URL", value);

    expect(buildSiteOrigin()).toBeUndefined();
  });

  it("is the origin without the whitespace around it", () => {
    vi.stubEnv("VITE_SITE_URL", " https://haulcast.example ");

    expect(buildSiteOrigin()).toBe("https://haulcast.example");
  });

  it("fails the build, naming the value, when the origin is not an absolute URL (RT-F1)", () => {
    vi.stubEnv("VITE_SITE_URL", "haulcast.example");

    expect(() => buildSiteOrigin()).toThrow(
      'VITE_SITE_URL must be an absolute URL such as https://haulcast.example, got "haulcast.example"',
    );
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
