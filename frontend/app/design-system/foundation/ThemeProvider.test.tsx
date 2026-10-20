import { act, render, renderHook, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installMatchMedia } from "../../../test/match-media";
import { DARK_QUERY, THEME_STORAGE_KEY } from "./theme";
import type { ThemeStorage } from "./theme";
import { createThemeStore } from "./theme-store";
import { ThemeProvider, useTheme } from "./ThemeProvider";

function freshStore(initial?: string): {
  readonly store: ReturnType<typeof createThemeStore>;
  readonly data: Map<string, string>;
  readonly root: HTMLElement;
} {
  const data = new Map<string, string>(initial === undefined ? [] : [[THEME_STORAGE_KEY, initial]]);
  const storage: ThemeStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
  const root = document.createElement("html");
  return { store: createThemeStore(() => ({ storage, root, events: window })), data, root };
}

function Probe(): ReactElement {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <output data-testid="theme">{theme}</output>
      <output data-testid="resolved">{resolvedTheme}</output>
      <button
        type="button"
        onClick={() => {
          setTheme("dark");
        }}
      >
        Go dark
      </button>
    </div>
  );
}

describe("ThemeProvider and useTheme", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("starts on system, which paints light when the operating system prefers light", () => {
    installMatchMedia({ [DARK_QUERY]: false });
    const { store } = freshStore();

    render(
      <ThemeProvider store={store}>
        <Probe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("theme")).toHaveTextContent("system");
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
  });

  it("paints dark for system when the operating system prefers dark, and follows it live", () => {
    const media = installMatchMedia({ [DARK_QUERY]: true });
    const { store } = freshStore();
    render(
      <ThemeProvider store={store}>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");

    act(() => {
      media.setMatches(DARK_QUERY, false);
    });

    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    expect(screen.getByTestId("theme")).toHaveTextContent("system");
  });

  it("uses the saved choice and ignores the operating system for an explicit theme", () => {
    installMatchMedia({ [DARK_QUERY]: false });
    const { store } = freshStore("dark");

    render(
      <ThemeProvider store={store}>
        <Probe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("theme")).toHaveTextContent("dark");
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
  });

  it("applies, saves and re-renders when the choice changes", () => {
    installMatchMedia({ [DARK_QUERY]: false });
    const { store, data, root } = freshStore();
    render(
      <ThemeProvider store={store}>
        <Probe />
      </ThemeProvider>,
    );

    act(() => {
      screen.getByRole("button", { name: "Go dark" }).click();
    });

    expect(screen.getByTestId("theme")).toHaveTextContent("dark");
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
    expect(data.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(root.dataset["theme"]).toBe("dark");
  });

  it("follows a change made in another tab", () => {
    installMatchMedia({ [DARK_QUERY]: false });
    const { store, data } = freshStore("light");
    render(
      <ThemeProvider store={store}>
        <Probe />
      </ThemeProvider>,
    );

    act(() => {
      data.set(THEME_STORAGE_KEY, "dark");
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    });

    expect(screen.getByTestId("theme")).toHaveTextContent("dark");
  });

  it("uses the browser store when none is given: it reads the choice saved in this browser", async () => {
    installMatchMedia({ [DARK_QUERY]: false });
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    // The browser store is a module singleton that reads storage once, on first use. A fresh copy
    // of the module reads what this test just saved.
    vi.resetModules();
    const fresh = await import("./ThemeProvider");
    function FreshProbe(): ReactElement {
      return <output data-testid="theme">{fresh.useTheme().theme}</output>;
    }

    render(
      <fresh.ThemeProvider>
        <FreshProbe />
      </fresh.ThemeProvider>,
    );

    expect(screen.getByTestId("theme")).toHaveTextContent("dark");
  });

  it("refuses to be used outside a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => renderHook(() => useTheme())).toThrow(
      "useTheme must be used inside a ThemeProvider.",
    );
  });
});
