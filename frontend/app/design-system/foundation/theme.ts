/** The three choices a person can make; `system` follows the operating system. */
export type Theme = "light" | "dark" | "system";

/** What is actually painted: `system` resolved against the operating system's preference. */
export type ResolvedTheme = "light" | "dark";

/** In display order. */
export const THEMES: readonly Theme[] = ["light", "dark", "system"];

/** Everyone starts on `system`: respect the operating system until told otherwise (R13). */
export const DEFAULT_THEME: Theme = "system";

/** `localStorage` key of the saved choice (DESIGN.md section 10, ThemeToggle). */
export const THEME_STORAGE_KEY = "hc-theme";

/** The one media query that decides what `system` means. */
export const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Narrows an unknown stored value to a theme. */
export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

/** The part of `Storage` the theme code needs, so tests and private-mode browsers can stand in. */
export interface ThemeStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/**
 * Reads the saved choice. Storage can be missing or throw (Safari private mode, blocked cookies),
 * and a stale or hand-edited value is not a theme: every such case falls back to the default.
 */
export function readStoredTheme(storage: ThemeStorage | undefined): Theme {
  try {
    const stored = storage?.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Saves the choice. A failure to save must never break switching the theme on screen. */
export function writeStoredTheme(storage: ThemeStorage | undefined, theme: Theme): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The theme still applies for this visit; it is just not remembered.
  }
}

/** `system` becomes light or dark according to the operating system. */
export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === "system") {
    return prefersDark ? "dark" : "light";
  }
  return theme;
}
