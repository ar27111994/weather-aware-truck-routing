/**
 * The voice rules of DESIGN.md section 13 as patterns, each with what it forbids. They apply to
 * every word the product shows, wherever the word is written: `microcopy.json` and the
 * documentation of each specimen on `/design`.
 */
export const VOICE_RULES: readonly [rule: string, pattern: RegExp][] = [
  ["emoji", /\p{Emoji_Presentation}/u],
  ["em or en dashes", /[\u2013\u2014]/],
  ["arrows or inequality glyphs the font lacks", /[\u2192\u2264\u2265]/],
  ["exclamation marks", /!/],
];
