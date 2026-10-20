import { createHash } from "node:crypto";

import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import cspHashes from "../../../csp-hashes.json";
import { THEME_INIT_SCRIPT, THEME_INIT_SCRIPT_SHA256 } from "./theme-script";

function sha256(text: string): string {
  return `sha256-${createHash("sha256").update(text, "utf8").digest("base64")}`;
}

/** Runs the script the way the browser does: as an inline script element in the head. */
function runScript(): void {
  const script = document.createElement("script");
  script.textContent = THEME_INIT_SCRIPT;
  document.head.append(script);
  script.remove();
}

afterEach(() => {
  delete document.documentElement.dataset["theme"];
  window.localStorage.clear();
});

describe("the no-flash theme script", () => {
  it("has its SHA-256 recorded for the CSP, in code and in csp-hashes.json", () => {
    expect(THEME_INIT_SCRIPT_SHA256).toBe(sha256(THEME_INIT_SCRIPT));
    expect(cspHashes.themeInitScript).toBe(sha256(THEME_INIT_SCRIPT));
  });

  it("contains none of the characters React escapes, so the hash holds in prerendered HTML", () => {
    expect(THEME_INIT_SCRIPT).not.toMatch(/[&<>"']/);
  });

  it("is written into the page byte for byte by React", () => {
    const html = renderToString(<script>{THEME_INIT_SCRIPT}</script>);

    expect(html).toBe(`<script>${THEME_INIT_SCRIPT}</script>`);
    expect(sha256(html.slice("<script>".length, -"</script>".length))).toBe(
      THEME_INIT_SCRIPT_SHA256,
    );
  });

  it.each(["light", "dark", "system"])("applies a saved %s before first paint", (theme) => {
    window.localStorage.setItem("hc-theme", theme);

    runScript();

    expect(document.documentElement.dataset["theme"]).toBe(theme);
  });

  it("falls back to system when nothing is saved", () => {
    runScript();

    expect(document.documentElement.dataset["theme"]).toBe("system");
  });

  it("falls back to system for a value that is not a theme", () => {
    window.localStorage.setItem("hc-theme", "sepia");

    runScript();

    expect(document.documentElement.dataset["theme"]).toBe("system");
  });

  it("falls back to system when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    runScript();

    expect(document.documentElement.dataset["theme"]).toBe("system");
  });
});
