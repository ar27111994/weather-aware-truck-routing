import { index, route } from "@react-router/dev/routes";
import type { RouteConfig } from "@react-router/dev/routes";

/**
 * `/` and `/methodology` are prerendered (see `react-router.config.ts`). `/design` is the
 * client-rendered kitchen sink (noindex, left out of the sitemap). The `*` route catches every
 * other address and shows the not-found page inside the app shell.
 */
export default [
  index("routes/home.tsx"),
  route("methodology", "routes/methodology.tsx"),
  route("design", "routes/design.tsx"),
  route("design/map", "routes/design-map.tsx"),
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
