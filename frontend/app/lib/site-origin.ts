/**
 * The site origin that a `VITE_SITE_URL` value stands for, or `undefined` when there is none. This
 * is the one rule for it: the build (`buildSiteOrigin`), the page tags and structured data
 * (`SITE_URL` in `shell/page-meta.ts`) and the crawler files all get the origin through here, so
 * they cannot disagree about whether the site has one.
 *
 * - Unset, empty and blank values mean no origin. A variable that is set but empty is common (a
 *   `VITE_SITE_URL=` line in a `.env` file, an empty variable in a CI or hosting dashboard), and it
 *   means the same as no variable.
 * - A value of any other kind has to work as the base of an absolute URL. One that does not fails
 *   here, naming the value, instead of quietly shipping pages without canonical links.
 * - A value that works comes back without the whitespace around it.
 *
 * @throws {Error} when the value is not blank and not an absolute URL.
 */
export function siteOrigin(value: string | undefined): string | undefined {
  const origin = value?.trim();
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
