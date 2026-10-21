/** What the Open Graph template needs besides itself. */
export interface OgParts {
  /** The design tokens as CSS (`app/design-system/tokens/tokens.css`). */
  readonly tokens: string;
  /** The latin Overpass and Overpass Mono font files, which the template cannot fetch from a CDN. */
  readonly fonts: { readonly sans: Uint8Array; readonly mono: Uint8Array };
}

/** A font file as the `src` of an `@font-face`. */
function fontFace(family: string, weights: string, file: Uint8Array): string {
  const data = Buffer.from(file).toString("base64");
  return `@font-face { font-family: "${family}"; src: url("data:font/woff2;base64,${data}") format("woff2"); font-weight: ${weights}; font-display: block; }`;
}

/**
 * Fills the placeholders of the Open Graph template (`scripts/brand/og.html`) with the tokens and
 * the fonts, so the page can be rendered with no network and always with the right typefaces.
 *
 * @throws {Error} If the template lacks a placeholder: the render would silently use fallback fonts.
 */
export function buildOgHtml(template: string, parts: OgParts): string {
  for (const placeholder of ["/*FONTS*/", "/*TOKENS*/"]) {
    if (!template.includes(placeholder)) {
      throw new Error(`The Open Graph template has no ${placeholder} placeholder.`);
    }
  }
  const fonts = [
    fontFace("Overpass Variable", "100 900", parts.fonts.sans),
    fontFace("Overpass Mono Variable", "100 900", parts.fonts.mono),
  ].join("\n");
  return template.replace("/*FONTS*/", () => fonts).replace("/*TOKENS*/", () => parts.tokens);
}
