import type { RiskRules } from "../../api/contract";
import { t } from "../../design-system/foundation/strings";
import { RISK_RULES } from "../../lib/risk";
import { methodologySections } from "../methodology/markdown";

/** The pages search engines may list (D-27: the style guide at `/design` is left out). */
export const SITEMAP_PATHS = ["/", "/methodology"] as const;

/** Crawlers of AI assistants and AI search, each told in so many words that the whole site is open. */
export const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "PerplexityBot",
  "Google-Extended",
  "Applebot-Extended",
] as const;

/** An address on the site: absolute when the build knows the site's origin, else the bare path. */
function address(origin: string | undefined, path: string): string {
  return origin === undefined ? path : new URL(path, origin).href;
}

/**
 * `robots.txt`: every crawler may read every page, the API is not for crawling, and the sitemap is
 * named (with an absolute address, as the standard asks) when the site's origin is known.
 */
export function robotsTxt(origin: string | undefined): string {
  const rules = ["Allow: /", "Disallow: /api/"];
  const groups = ["*", ...AI_CRAWLERS].map((agent) =>
    [`User-agent: ${agent}`, ...rules].join("\n"),
  );
  const sitemap = origin === undefined ? [] : [`Sitemap: ${address(origin, "/sitemap.xml")}`];
  return `${[...groups, ...sitemap].join("\n\n")}\n`;
}

/**
 * `sitemap.xml`: the pages that may be listed, each by its absolute address (the standard asks for
 * one). It takes an origin and nothing else: a build that does not know the site's origin has no
 * address to list, and a `<urlset>` with no `<url>` is not a valid sitemap, so that build writes
 * none (see `prerenderPaths`). There is no `<lastmod>` either: it is optional, a build knows no
 * date for a page except its own, and a crawler learns to ignore a `lastmod` that is the build day
 * for every page. The same sources give the same bytes on every day.
 */
export function sitemapXml(origin: string): string {
  const urls = SITEMAP_PATHS.map(
    (path) => `  <url>\n    <loc>${address(origin, path)}</loc>\n  </url>`,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

/** `llms.txt` (llmstxt.org): a title, a summary, and a short list of the pages worth reading. */
export function llmsTxt(origin: string | undefined): string {
  const link = (label: string, url: string, note: string): string =>
    `- [${label}](${url}): ${note}`;
  return [
    `# ${t("app.name")}`,
    `> ${t("app.description")}`,
    t("seo.llms.intro"),
    `## ${t("seo.llms.pages")}`,
    [
      link(t("app.nav.planner"), address(origin, "/"), t("seo.llms.planner")),
      link(t("app.nav.methodology"), address(origin, "/methodology"), t("seo.llms.methodology")),
      link("llms-full.txt", address(origin, "/llms-full.txt"), t("seo.llms.full")),
      link(t("footer.source"), t("footer.sourceUrl"), t("seo.llms.source")),
    ].join("\n"),
    "",
  ].join("\n\n");
}

/** `llms-full.txt`: the methodology as one Markdown document, from the same rules file the engine reads. */
export function llmsFullTxt(origin: string | undefined, rules: RiskRules = RISK_RULES): string {
  return [
    `# ${t("app.name")}: ${t("methodology.title")}`,
    `> ${t("app.description")}`,
    t("seo.llms.intro"),
    `Page: ${address(origin, "/methodology")}`,
    methodologySections(rules),
    "",
  ].join("\n\n");
}
