import { describe, expect, it } from "vitest";

import { memoryThemeStorage } from "../../../test/theme-store";
import {
  DEFAULT_THEME,
  THEMES,
  THEME_STORAGE_KEY,
  isTheme,
  readStoredTheme,
  resolveTheme,
  writeStoredTheme,
} from "./theme";
import type { ThemeStorage } from "./theme";

const THROWING: ThemeStorage = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("quota", "QuotaExceededError");
  },
};

describe("theme choices", () => {
  it("are light, dark and system, in that order, and start on system", () => {
    expect(THEMES).toEqual(["light", "dark", "system"]);
    expect(DEFAULT_THEME).toBe("system");
    expect(THEME_STORAGE_KEY).toBe("hc-theme");
  });

  it.each(["light", "dark", "system"])("accepts %s", (value) => {
    expect(isTheme(value)).toBe(true);
  });

  it.each(["", "Light", "auto", "dark ", null, undefined, 1, {}])("rejects %j", (value) => {
    expect(isTheme(value)).toBe(false);
  });
});

describe("readStoredTheme", () => {
  it.each(["light", "dark", "system"] as const)("returns the saved %s", (theme) => {
    expect(readStoredTheme(memoryThemeStorage({ [THEME_STORAGE_KEY]: theme }))).toBe(theme);
  });

  it("falls back to the default when nothing is saved", () => {
    expect(readStoredTheme(memoryThemeStorage())).toBe("system");
  });

  it("falls back to the default for a value that is not a theme", () => {
    expect(readStoredTheme(memoryThemeStorage({ [THEME_STORAGE_KEY]: "sepia" }))).toBe("system");
  });

  it("falls back to the default without storage", () => {
    expect(readStoredTheme(undefined)).toBe("system");
  });

  it("falls back to the default when reading storage throws", () => {
    expect(readStoredTheme(THROWING)).toBe("system");
  });
});

describe("writeStoredTheme", () => {
  it("saves the choice under hc-theme", () => {
    const storage = memoryThemeStorage();

    writeStoredTheme(storage, "dark");

    expect(storage.data.get("hc-theme")).toBe("dark");
  });

  it("does nothing without storage", () => {
    expect(() => {
      writeStoredTheme(undefined, "dark");
    }).not.toThrow();
  });

  it("never lets a failed save break switching the theme", () => {
    expect(() => {
      writeStoredTheme(THROWING, "dark");
    }).not.toThrow();
  });
});

describe("resolveTheme", () => {
  it.each([
    ["light", false, "light"],
    ["light", true, "light"],
    ["dark", false, "dark"],
    ["dark", true, "dark"],
    ["system", false, "light"],
    ["system", true, "dark"],
  ] as const)("%s with prefersDark=%s paints %s", (theme, prefersDark, expected) => {
    expect(resolveTheme(theme, prefersDark)).toBe(expected);
  });
});
