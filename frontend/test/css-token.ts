import { readFileSync } from "node:fs";
import { join } from "node:path";

const TOKENS_CSS = join(import.meta.dirname, "..", "app", "design-system", "tokens", "tokens.css");

/**
 * What `tokens.css` gives a custom property, as written: `"1px"`, `"0.5"`. Component code that has
 * to repeat a token as a number (an SVG attribute, a layout calculation, a positioning API) is
 * pinned to the stylesheet by a test that reads the value here, so the two cannot drift apart
 * unseen. (Vitest swaps a CSS import for an empty module, so the file is read from disk.)
 *
 * A property the file declares more than once, such as one that differs by theme, has no single
 * value; asking for it fails instead of picking one of them.
 *
 * @param name - The property without its dashes: `c-stacked-bar-gap` is `--c-stacked-bar-gap`.
 */
export function cssTokenValue(name: string): string {
  const prefix = `--${name}:`;
  const declared = readFileSync(TOKENS_CSS, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).replace(/;$/u, "").trim());
  const [value] = declared;
  if (value === undefined || declared.length > 1) {
    throw new Error(
      `Expected --${name} to be declared once in tokens.css, found ${String(declared.length)}`,
    );
  }
  return value;
}
