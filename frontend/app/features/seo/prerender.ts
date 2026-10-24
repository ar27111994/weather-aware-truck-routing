import { loadEnv } from "vite";

/**
 * What the build writes out as static files, in the order the config lists them: the two pages, then
 * the crawler files.
 */
const PRERENDERED = [
  "/",
  "/methodology",
  "/robots.txt",
  "/sitemap.xml",
  "/llms.txt",
  "/llms-full.txt",
] as const;

/**
 * The site's origin as the build is given it: the value Vite hands the app as
 * `import.meta.env.VITE_SITE_URL` (process environment and `.env` files alike). The route list and
 * the prerender list both read it here, so the files the build writes, the routes that serve them
 * and the pages it renders always agree on whether the origin is known. Build tooling only: the app
 * never imports this module.
 */
export function buildSiteOrigin(): string | undefined {
  return loadEnv("production", process.cwd(), "VITE_")["VITE_SITE_URL"];
}

/**
 * The paths the build writes out. A sitemap lists absolute addresses, so it is written only when
 * the build knows the site's origin: without one it would be an empty `<urlset>`, which the sitemap
 * schema does not accept. With no origin the sitemap route is not registered either (React Router
 * refuses a route with a `loader` that is not prerendered when there is no server), so
 * `/sitemap.xml` is a plain 404, which is what a site that has no sitemap should answer.
 */
export function prerenderPaths(origin: string | undefined): string[] {
  return PRERENDERED.filter((path) => origin !== undefined || path !== "/sitemap.xml");
}
