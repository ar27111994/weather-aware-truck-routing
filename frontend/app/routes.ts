import { index, route } from "@react-router/dev/routes";
import type { RouteConfig } from "@react-router/dev/routes";

import { buildSiteOrigin } from "./features/seo/prerender";

/**
 * `/` and `/methodology` are prerendered (see `react-router.config.ts`). `/design` is the
 * client-rendered kitchen sink (noindex, left out of the sitemap). The `*` route catches every
 * other address and shows the not-found page inside the app shell. The sitemap is a route only when
 * the build knows the site's origin: it lists absolute addresses, and without an origin the build
 * writes no sitemap (`prerenderPaths`), which React Router allows only for a route that is not
 * registered.
 *
 * The list is a constant that the last line exports, not an `export default [...]`: Vitest's v8
 * provider counts no statement in `export default <expression>`, so a file that is only that is
 * never measured by the coverage gate (RT-F3, scripts/coverage-gate/blind-spots.ts).
 */
const routes = [
  index("routes/home.tsx"),
  route("methodology", "routes/methodology.tsx"),
  route("design", "routes/design.tsx"),
  route("design/map", "routes/design-map.tsx"),
  route("robots.txt", "routes/robots.ts"),
  ...(buildSiteOrigin() === undefined ? [] : [route("sitemap.xml", "routes/sitemap.ts")]),
  route("llms.txt", "routes/llms.ts"),
  route("llms-full.txt", "routes/llms-full.ts"),
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;

export default routes;
