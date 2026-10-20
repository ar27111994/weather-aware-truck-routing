import { createContext, use, useMemo, useSyncExternalStore } from "react";
import type { ReactElement, ReactNode } from "react";

import { DARK_QUERY, resolveTheme } from "./theme";
import type { ResolvedTheme, Theme } from "./theme";
import { browserThemeStore } from "./theme-store";
import type { ThemeStore } from "./theme-store";
import { useMediaQuery } from "./useMediaQuery";

/** What `useTheme` returns. */
export interface ThemeContextValue {
  /** The choice: light, dark or system. */
  readonly theme: Theme;
  /** What is painted: `system` resolved against the operating system. Use it for the map style. */
  readonly resolvedTheme: ResolvedTheme;
  /** Applies, saves and broadcasts a new choice. */
  readonly setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export interface ThemeProviderProps {
  readonly children: ReactNode;
  /** Defaults to the browser store; tests pass their own. */
  readonly store?: ThemeStore;
}

/**
 * Holds the theme choice (persisted as `hc-theme`) and the resolved theme. The inline script in
 * `<head>` has already put the right `data-theme` on `<html>` before first paint; this provider
 * only keeps it in sync after that.
 */
export function ThemeProvider({
  children,
  store = browserThemeStore,
}: ThemeProviderProps): ReactElement {
  const theme = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const prefersDark = useMediaQuery(DARK_QUERY);
  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme: resolveTheme(theme, prefersDark), setTheme: store.set }),
    [theme, prefersDark, store.set],
  );
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

/**
 * The current theme and a way to change it.
 *
 * @throws {Error} Outside a {@link ThemeProvider}: a developer error.
 */
export function useTheme(): ThemeContextValue {
  const value = use(ThemeContext);
  if (value === undefined) {
    throw new Error("useTheme must be used inside a ThemeProvider.");
  }
  return value;
}
