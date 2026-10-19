import type { Config } from "@react-router/dev/config";

/**
 * React Router framework mode as a prerendered single-page app: no server at runtime. `/` and
 * `/methodology` are rendered to static HTML at build time (SEO + instant first paint); every
 * other route is client-rendered. The API lives on the same origin under `/api` (Django on Vercel).
 */
export default {
  ssr: false,
  prerender: ["/", "/methodology"],
} satisfies Config;
