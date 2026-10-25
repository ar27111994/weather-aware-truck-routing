// @vitest-environment node
// The route config is Node code (it reads the build's environment through Vite, which cannot load
// under jsdom: esbuild refuses jsdom's TextEncoder), and nothing here needs a DOM.
import { afterEach, describe, expect, it, vi } from "vitest";
// The routes read the build's origin through Vite, which takes seconds to load on a busy machine.
// Loaded here, once, while the file is imported, it is not loaded inside the first test and its
// 5 s (Node keeps it across `vi.resetModules`; only the app's own modules are loaded again).
import "vite";

/** The route list as a build with this origin (or none) loads it: the origin is read at load. */
async function routesFor(origin: string | undefined) {
  vi.stubEnv("VITE_SITE_URL", origin);
  vi.resetModules();
  return (await import("./routes")).default;
}

/** The route config as a build with this origin (or none) loads it: the origin is read at load. */
async function reactRouterConfigFor(origin: string | undefined) {
  vi.stubEnv("VITE_SITE_URL", origin);
  vi.resetModules();
  return (await import("../react-router.config")).default;
}

afterEach(() => {
  vi.resetModules();
});

describe("route config", () => {
  it("has the prerendered pages, the client-rendered kitchen sink, the crawler files and a catch-all, in that order", async () => {
    expect(await routesFor("https://haulcast.example")).toEqual([
      expect.objectContaining({ index: true, file: "routes/home.tsx" }),
      expect.objectContaining({ path: "methodology", file: "routes/methodology.tsx" }),
      expect.objectContaining({ path: "design", file: "routes/design.tsx" }),
      expect.objectContaining({ path: "design/map", file: "routes/design-map.tsx" }),
      expect.objectContaining({ path: "robots.txt", file: "routes/robots.ts" }),
      expect.objectContaining({ path: "sitemap.xml", file: "routes/sitemap.ts" }),
      expect.objectContaining({ path: "llms.txt", file: "routes/llms.ts" }),
      expect.objectContaining({ path: "llms-full.txt", file: "routes/llms-full.ts" }),
      expect.objectContaining({ path: "*", file: "routes/not-found.tsx" }),
    ]);
  });

  it("has no sitemap route when the build has no origin to list (R4-15)", async () => {
    const paths = (await routesFor(undefined)).map((entry) => entry.path);

    expect(paths).toEqual([
      undefined,
      "methodology",
      "design",
      "design/map",
      "robots.txt",
      "llms.txt",
      "llms-full.txt",
      "*",
    ]);
  });

  it("writes both pages and every crawler file out at build time, and nothing else", async () => {
    const config = await reactRouterConfigFor("https://haulcast.example");

    expect(config.prerender).toEqual([
      "/",
      "/methodology",
      "/robots.txt",
      "/sitemap.xml",
      "/llms.txt",
      "/llms-full.txt",
    ]);
  });

  it("writes no sitemap when the build has no origin to list (R4-15)", async () => {
    const config = await reactRouterConfigFor(undefined);

    expect(config.prerender).not.toContain("/sitemap.xml");
    expect(config.prerender).toContain("/robots.txt");
  });

  // A variable that is set but empty (a `VITE_SITE_URL=` line in a .env file, an empty variable in
  // a hosting dashboard) is no origin, exactly as an unset one is.
  it.each([
    ["empty", ""],
    ["blank", "   "],
  ])("has no sitemap route when the origin is set but %s (RT-F1)", async (_how, value) => {
    const paths = (await routesFor(value)).map((entry) => entry.path);

    expect(paths).toEqual([
      undefined,
      "methodology",
      "design",
      "design/map",
      "robots.txt",
      "llms.txt",
      "llms-full.txt",
      "*",
    ]);
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
  ])("writes no sitemap when the origin is set but %s (RT-F1)", async (_how, value) => {
    const config = await reactRouterConfigFor(value);

    expect(config.prerender).toEqual([
      "/",
      "/methodology",
      "/robots.txt",
      "/llms.txt",
      "/llms-full.txt",
    ]);
  });

  it("stops the build, naming the value, when the origin is not an absolute URL (RT-F1)", async () => {
    const message =
      'VITE_SITE_URL must be an absolute URL such as https://haulcast.example, got "haulcast.example"';

    await expect(routesFor("haulcast.example")).rejects.toThrow(message);
    await expect(reactRouterConfigFor("haulcast.example")).rejects.toThrow(message);
  });
});
