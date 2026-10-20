import type { MetaDescriptor } from "react-router";

import { t } from "../design-system/foundation/strings";

/** Open Graph image, 1200 by 630, served from `public/` (the headers and pages cards own the file). */
export const OG_IMAGE_PATH = "/og.png";

/** Origin of the deployed site, set at build time (`VITE_SITE_URL`); canonical URLs need it. */
export const SITE_URL: string | undefined = import.meta.env.VITE_SITE_URL;

interface PageMetaBase {
  readonly title: string;
  readonly description: string;
  /** Overrides {@link SITE_URL}; without an origin the absolute-URL tags are left out. */
  readonly siteUrl?: string | undefined;
}

/** A page search engines may list. It needs its path for the canonical link and `og:url`. */
interface IndexablePage extends PageMetaBase {
  /** Path of the page, such as `/methodology`. */
  readonly path: string;
  readonly noindex?: false;
}

/**
 * A page that stays out of search results (the kitchen sink, the not-found page). It declares no
 * canonical link and no `og:url`: a canonical for a page nobody should index contradicts `noindex`.
 */
interface HiddenPage extends PageMetaBase {
  readonly noindex: true;
  readonly path?: undefined;
}

export type PageMetaOptions = IndexablePage | HiddenPage;

/**
 * The configured site origin, or `undefined` when there is none. A blank value counts as not set
 * (an empty variable in a CI or hosting dashboard). Anything else has to work as the base of an
 * absolute URL, and a value that does not fails the build here rather than quietly shipping pages
 * without canonical links.
 */
function siteOrigin(siteUrl: string | undefined): string | undefined {
  const origin = siteUrl?.trim();
  if (origin === undefined || origin === "") {
    return undefined;
  }
  if (!URL.canParse("/", origin)) {
    throw new Error(
      `VITE_SITE_URL must be an absolute URL such as https://haulcast.example, got "${origin}"`,
    );
  }
  return origin;
}

/**
 * The `meta` export of a route, in one call: title, description, canonical link, Open Graph and
 * Twitter card tags (R12). Without a site origin there is nothing honest to put in an absolute URL,
 * so the canonical link, `og:url` and the image tags are omitted rather than guessed.
 *
 * @example
 * export const meta = () => pageMeta({ title: "Methodology", description: "...", path: "/methodology" });
 * @example
 * export const meta = () => pageMeta({ title: "Design system", description: "...", noindex: true });
 */
export function pageMeta(options: PageMetaOptions): MetaDescriptor[] {
  const { title, description, siteUrl = SITE_URL } = options;
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
  if (options.noindex === true) {
    tags.push({ name: "robots", content: "noindex, nofollow" });
  }
  const origin = siteOrigin(siteUrl);
  if (origin !== undefined) {
    const image = new URL(OG_IMAGE_PATH, origin).href;
    if (options.noindex !== true) {
      const url = new URL(options.path, origin).href;
      tags.push(
        { tagName: "link", rel: "canonical", href: url },
        { property: "og:url", content: url },
      );
    }
    tags.push(
      { property: "og:image", content: image },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { name: "twitter:image", content: image },
    );
  }
  return tags;
}
