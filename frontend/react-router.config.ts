import type { Config } from "@react-router/dev/config";

import { buildSiteOrigin, prerenderPaths } from "./app/features/seo/prerender";

/**
 * React Router framework mode as a prerendered single-page app: no server at runtime. `/` and
 * `/methodology` are rendered to static HTML at build time (SEO + instant first paint); every
 * other route is client-rendered. The API lives on the same origin under `/api` (Django on Vercel).
 * The crawler files are written out too; the sitemap only when the build knows the site's origin.
 */
export default {
  ssr: false,
  prerender: prerenderPaths(buildSiteOrigin()),
} satisfies Config;
