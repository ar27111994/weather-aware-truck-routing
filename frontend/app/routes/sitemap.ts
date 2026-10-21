import { sitemapXml } from "../features/seo/files";
import { SITE_URL } from "../shell/page-meta";

/** `/sitemap.xml`, written out at build time (a prerendered resource route). */
export function loader(): Response {
  return new Response(sitemapXml(SITE_URL, new Date()), {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
