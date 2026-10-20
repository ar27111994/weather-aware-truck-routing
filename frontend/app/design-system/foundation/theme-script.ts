/**
 * The no-flash theme script (R13). It runs before first paint, as an inline script in `<head>`,
 * and sets `<html data-theme>` from the saved choice so the page never flashes the wrong theme.
 * `system` needs no JavaScript: `tokens.css` resolves it with `prefers-color-scheme`.
 *
 * Two constraints shape the text:
 *
 * - It is served under a strict CSP, which allows it by hash. Any edit changes the hash, so
 *   `THEME_INIT_SCRIPT_SHA256` and `frontend/csp-hashes.json` must change with it (a test fails
 *   until they do).
 * - React writes a script element's text children HTML-escaped, which would turn a quote into
 *   `&quot;` and break the code. The script therefore uses only backtick strings and none of the
 *   characters React escapes (`& < > " '`); a test renders it and compares the bytes.
 *
 * The key is `hc-theme` and the values are `light`, `dark` and `system`; they mirror
 * `THEME_STORAGE_KEY` and `isTheme` in `theme.ts` (a test runs the script against them).
 */
export const THEME_INIT_SCRIPT =
  "(function(){try{var t=localStorage.getItem(`hc-theme`);" +
  "document.documentElement.dataset.theme=t===`light`||t===`dark`?t:`system`}" +
  "catch(e){document.documentElement.dataset.theme=`system`}})()";

/** Base64 SHA-256 of {@link THEME_INIT_SCRIPT}, the value a CSP `script-src 'sha256-...'` needs. */
export const THEME_INIT_SCRIPT_SHA256 = "sha256-LLd6t/EpG+205H1OIXnkzTe3MTjYoqE0Z6fwsKAAJy8=";
