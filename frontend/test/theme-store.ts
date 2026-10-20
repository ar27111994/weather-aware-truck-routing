import { THEME_STORAGE_KEY } from "../app/design-system/foundation/theme";
import type { ThemeStorage } from "../app/design-system/foundation/theme";
import { createThemeStore } from "../app/design-system/foundation/theme-store";
import type { ThemeEnvironment, ThemeStore } from "../app/design-system/foundation/theme-store";

/** Theme storage kept in a map, so a test can seed it and read back what was saved. */
export interface MemoryThemeStorage extends ThemeStorage {
  readonly data: Map<string, string>;
}

/**
 * @param initial - Keys and values already in storage.
 */
export function memoryThemeStorage(initial?: Readonly<Record<string, string>>): MemoryThemeStorage {
  const data = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

/** What a theme store touches, all of it private to one test: memory storage and a detached `<html>`. */
export interface MemoryThemeEnvironment extends ThemeEnvironment {
  readonly storage: MemoryThemeStorage;
  readonly root: HTMLElement;
}

/**
 * @param saved - The theme choice already saved, if any.
 */
export function memoryThemeEnvironment(saved?: string): MemoryThemeEnvironment {
  return {
    storage: memoryThemeStorage(saved === undefined ? {} : { [THEME_STORAGE_KEY]: saved }),
    root: document.createElement("html"),
    events: window,
  };
}

/** A theme store on {@link memoryThemeEnvironment}, with the environment it uses. */
export function memoryThemeStore(saved?: string): {
  readonly store: ThemeStore;
  readonly environment: MemoryThemeEnvironment;
} {
  const environment = memoryThemeEnvironment(saved);
  return { store: createThemeStore(() => environment), environment };
}

/** A theme store with no storage at all (blocked, as in some privacy modes). */
export function unsavedThemeStore(): ThemeStore {
  return createThemeStore(() => ({
    storage: undefined,
    root: document.createElement("html"),
    events: window,
  }));
}
