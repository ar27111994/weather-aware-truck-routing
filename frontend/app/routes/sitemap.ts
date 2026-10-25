import { sitemapXml } from "../features/seo/files";
import { SITE_URL } from "../shell/page-meta";

/**
 * `/sitemap.xml`, written out at build time (a prerendered resource route) when the build knows the
 * site's origin. Without one there is no address to list, and the build does not write the file
 * (`prerenderPaths`); a dev server then answers 404, never an empty `<urlset>`.
 */
export function loader(): Response {
  if (SITE_URL === undefined) {
    return new Response(null, { status: 404 });
  }
  return new Response(sitemapXml(SITE_URL), {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
