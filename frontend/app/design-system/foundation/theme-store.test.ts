import { afterEach, describe, expect, it, vi } from "vitest";

import { defined } from "../../../test/defined";
import { THEME_STORAGE_KEY } from "./theme";
import type { ThemeStorage } from "./theme";
import { createThemeStore } from "./theme-store";
import type { ThemeEnvironment } from "./theme-store";

function environment(initial?: string): ThemeEnvironment & {
  readonly data: Map<string, string>;
} {
  const data = new Map<string, string>(initial === undefined ? [] : [[THEME_STORAGE_KEY, initial]]);
  const storage: ThemeStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
  return { data, storage, root: document.createElement("html"), events: window };
}

function storageEvent(key: string | null): void {
  window.dispatchEvent(new StorageEvent("storage", { key }));
}

afterEach(() => {
  vi.resetModules();
});

describe("createThemeStore", () => {
  it("reads the saved choice, and the default when there is none", () => {
    expect(createThemeStore(() => environment("dark")).getSnapshot()).toBe("dark");
    expect(createThemeStore(() => environment()).getSnapshot()).toBe("system");
  });

  it("reads storage once and keeps the answer", () => {
    const env = environment("dark");
    const getItem = vi.spyOn(defined(env.storage, "storage"), "getItem");
    const store = createThemeStore(() => env);

    store.getSnapshot();
    store.getSnapshot();

    expect(getItem).toHaveBeenCalledTimes(1);
  });

  it("serves the default on the server, whatever is saved", () => {
    expect(createThemeStore(() => environment("dark")).getServerSnapshot()).toBe("system");
  });

  it("applies, saves and announces a new choice", () => {
    const env = environment();
    const store = createThemeStore(() => env);
    const first = vi.fn();
    const second = vi.fn();
    store.subscribe(first);
    store.subscribe(second);

    store.set("dark");

    expect(store.getSnapshot()).toBe("dark");
    expect(env.data.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(env.root.dataset["theme"]).toBe("dark");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("still switches the theme when saving is impossible", () => {
    const env = { ...environment(), storage: undefined };
    const store = createThemeStore(() => env);

    store.set("light");

    expect(store.getSnapshot()).toBe("light");
    expect(env.root.dataset["theme"]).toBe("light");
  });

  it("listens for other tabs only while somebody is subscribed", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const store = createThemeStore(() => environment());

    const stopFirst = store.subscribe(vi.fn());
    const stopSecond = store.subscribe(vi.fn());
    expect(add.mock.calls.filter(([type]) => type === "storage")).toHaveLength(1);

    stopFirst();
    expect(remove.mock.calls.filter(([type]) => type === "storage")).toHaveLength(0);

    stopSecond();
    expect(remove.mock.calls.filter(([type]) => type === "storage")).toHaveLength(1);
  });

  it("follows a theme change made in another tab", () => {
    const env = environment("light");
    const store = createThemeStore(() => env);
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    expect(store.getSnapshot()).toBe("light");

    env.data.set(THEME_STORAGE_KEY, "dark");
    storageEvent(THEME_STORAGE_KEY);

    expect(store.getSnapshot()).toBe("dark");
    expect(env.root.dataset["theme"]).toBe("dark");
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it("follows storage being cleared in another tab", () => {
    const env = environment("dark");
    const store = createThemeStore(() => env);
    const stop = store.subscribe(vi.fn());
    store.getSnapshot();

    env.data.clear();
    storageEvent(null);

    expect(store.getSnapshot()).toBe("system");
    expect(env.root.dataset["theme"]).toBe("system");
    stop();
  });

  it("ignores other keys changing in other tabs", () => {
    const env = environment("dark");
    const store = createThemeStore(() => env);
    const listener = vi.fn();
    const stop = store.subscribe(listener);

    storageEvent("something-else");

    expect(listener).not.toHaveBeenCalled();
    stop();
  });
});

describe("browserThemeStore", () => {
  afterEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset["theme"];
  });

  it("saves to localStorage and marks <html>", async () => {
    const { browserThemeStore } = await import("./theme-store");

    browserThemeStore.set("dark");

    expect(window.localStorage.getItem("hc-theme")).toBe("dark");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
  });

  it("reads what is already saved", async () => {
    window.localStorage.setItem("hc-theme", "light");
    const { browserThemeStore } = await import("./theme-store");

    expect(browserThemeStore.getSnapshot()).toBe("light");
  });

  it("works when the browser refuses access to localStorage", async () => {
    const getter = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    try {
      const { browserThemeStore } = await import("./theme-store");

      expect(browserThemeStore.getSnapshot()).toBe("system");
      browserThemeStore.set("dark");

      expect(browserThemeStore.getSnapshot()).toBe("dark");
      expect(document.documentElement.dataset["theme"]).toBe("dark");
    } finally {
      // The cleanup below needs the real storage back.
      getter.mockRestore();
    }
  });
});
