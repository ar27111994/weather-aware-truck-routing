import { describe, expect, it } from "vitest";

import reactRouterConfig from "../react-router.config";
import routes from "./routes";

describe("route config", () => {
  it("has the prerendered pages, the client-rendered kitchen sink, the crawler files and a catch-all, in that order", () => {
    expect(routes).toEqual([
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

  it("writes both pages and every crawler file out at build time, and nothing else", () => {
    expect(reactRouterConfig.prerender).toEqual([
      "/",
      "/methodology",
      "/robots.txt",
      "/sitemap.xml",
      "/llms.txt",
      "/llms-full.txt",
    ]);
  });
});
