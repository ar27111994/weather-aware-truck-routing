import { DEFAULT_THEME, THEME_STORAGE_KEY, readStoredTheme, writeStoredTheme } from "./theme";
import type { Theme, ThemeStorage } from "./theme";

/** Everything the store touches in the browser, so tests can hand it fakes. */
export interface ThemeEnvironment {
  /** `undefined` when storage is blocked (private mode, disabled cookies). */
  readonly storage: ThemeStorage | undefined;
  /** The `<html>` element that carries `data-theme`. */
  readonly root: HTMLElement;
  /** Where `storage` events (a theme change in another tab) arrive. */
  readonly events: Pick<Window, "addEventListener" | "removeEventListener">;
}

/** The shape `useSyncExternalStore` wants. */
export interface ThemeStore {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => Theme;
  /** Server and first client render agree on the default, so hydration never mismatches. */
  readonly getServerSnapshot: () => Theme;
  /** Applies the theme to `<html>`, saves it, and tells every subscriber. */
  readonly set: (theme: Theme) => void;
}

/**
 * Creates the theme store. The environment is a function so nothing touches `window` at import
 * time (the module is also loaded while prerendering).
 *
 * @param environment - Called when the store first needs the browser.
 */
export function createThemeStore(environment: () => ThemeEnvironment): ThemeStore {
  const listeners = new Set<() => void>();
  // The choice, once known: read lazily, then kept in memory so it also holds when saving fails.
  let current: Theme | undefined;

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === THEME_STORAGE_KEY) {
      current = undefined;
      environment().root.dataset["theme"] = readStoredTheme(environment().storage);
      notify();
    }
  };

  return {
    subscribe(onChange) {
      listeners.add(onChange);
      if (listeners.size === 1) {
        environment().events.addEventListener("storage", onStorage);
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) {
          environment().events.removeEventListener("storage", onStorage);
        }
      };
    },
    getSnapshot() {
      current ??= readStoredTheme(environment().storage);
      return current;
    },
    getServerSnapshot() {
      return DEFAULT_THEME;
    },
    set(theme) {
      current = theme;
      const { storage, root } = environment();
      writeStoredTheme(storage, theme);
      root.dataset["theme"] = theme;
      notify();
    },
  };
}

/** Browser storage, or `undefined` where touching it throws (some privacy modes). */
function browserStorage(): ThemeStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** The store the app uses. */
export const browserThemeStore: ThemeStore = createThemeStore(() => ({
  storage: browserStorage(),
  root: document.documentElement,
  events: window,
}));
