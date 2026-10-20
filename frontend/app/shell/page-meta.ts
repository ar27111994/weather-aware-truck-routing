import type { MetaDescriptor } from "react-router";

import { t } from "../design-system/foundation/strings";

/** Open Graph image, 1200 by 630, served from `public/` (the headers and pages cards own the file). */
export const OG_IMAGE_PATH = "/og.png";

/** Origin of the deployed site, set at build time (`VITE_SITE_URL`); canonical URLs need it. */
export const SITE_URL: string | undefined = import.meta.env["VITE_SITE_URL"] as string | undefined;

export interface PageMetaOptions {
  readonly title: string;
  readonly description: string;
  /** Path of the page, such as `/methodology`. */
  readonly path: string;
  /** Keep the page out of search results (the kitchen sink). */
  readonly noindex?: boolean;
  /** Overrides {@link SITE_URL}; without an origin the absolute-URL tags are left out. */
  readonly siteUrl?: string | undefined;
}

/**
 * The `meta` export of a route, in one call: title, description, canonical link, Open Graph and
 * Twitter card tags (R12). Without a site origin there is nothing honest to put in an absolute URL,
 * so the canonical link, `og:url` and the image tags are omitted rather than guessed.
 *
 * @example
 * export const meta = () => pageMeta({ title: "Methodology", description: "...", path: "/methodology" });
 */
export function pageMeta({
  title,
  description,
  path,
  noindex = false,
  siteUrl = SITE_URL,
}: PageMetaOptions): MetaDescriptor[] {
  const tags: MetaDescriptor[] = [
    { title },
    { name: "description", content: description },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: t("app.name") },
    { property: "og:locale", content: "en_US" },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
  ];
  if (noindex) {
    tags.push({ name: "robots", content: "noindex, nofollow" });
  }
  if (siteUrl !== undefined) {
    const url = new URL(path, siteUrl).href;
    const image = new URL(OG_IMAGE_PATH, siteUrl).href;
    tags.push(
      { tagName: "link", rel: "canonical", href: url },
      { property: "og:url", content: url },
      { property: "og:image", content: image },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { name: "twitter:image", content: image },
    );
  }
  return tags;
}
