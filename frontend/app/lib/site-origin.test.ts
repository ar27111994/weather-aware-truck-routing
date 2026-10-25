import { describe, expect, it, vi } from "vitest";

import { siteOrigin } from "./site-origin";

describe("siteOrigin", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["a space", " "],
    ["tabs and line breaks", "\t \r\n "],
    ["a non-breaking space", "\u00a0"],
  ])("is no origin when the value is %s", (_what, value) => {
    expect(siteOrigin(value)).toBeUndefined();
  });

  it("is the value when it is an absolute URL", () => {
    expect(siteOrigin("https://haulcast.example")).toBe("https://haulcast.example");
  });

  it("is the value without the whitespace around it", () => {
    expect(siteOrigin("  https://haulcast.example \n")).toBe("https://haulcast.example");
  });

  it.each(["haulcast.example", "localhost:3000", "/just/a/path", "https://"])(
    "fails loudly, naming the value, when %j is not an absolute URL",
    (value) => {
      expect(() => siteOrigin(value)).toThrow(
        `VITE_SITE_URL must be an absolute URL such as https://haulcast.example, got "${value}"`,
      );
    },
  );

  it("names the value without the whitespace around it when it fails", () => {
    expect(() => siteOrigin("  haulcast.example\t")).toThrow(
      'VITE_SITE_URL must be an absolute URL such as https://haulcast.example, got "haulcast.example"',
    );
  });
});

// Chrome before 120, Firefox before 115 and Safari before 17 have no `URL.canParse`. The app's floor
// is Chrome 107, Firefox 104 and Safari 16 (D-62), and this rule runs when the page's code loads
// (`SITE_URL` in shell/page-meta.ts), so a call to a missing `canParse` would stop the app there.
describe("siteOrigin on an engine without URL.canParse", () => {
  /** The URL of an engine at the floor: it parses as ever, and it has no `canParse`. */
  function urlOfAnOldEngine(): typeof URL {
    class OldEngineURL extends URL {}
    Object.defineProperty(OldEngineURL, "canParse", { value: undefined });
    return OldEngineURL;
  }

  /** The rule as an old engine loads it: a fresh copy of the module, under the old `URL`. */
  async function siteOriginOnAnOldEngine() {
    vi.stubGlobal("URL", urlOfAnOldEngine());
    vi.resetModules();
    return (await import("./site-origin")).siteOrigin;
  }

  it("has a stand-in that parses URLs and has no canParse", async () => {
    await siteOriginOnAnOldEngine();

    expect(typeof URL.canParse).toBe("undefined");
    expect(new URL("/", "https://haulcast.example").href).toBe("https://haulcast.example/");
  });

  it("is the value when it is an absolute URL", async () => {
    const onOldEngine = await siteOriginOnAnOldEngine();

    expect(onOldEngine("https://haulcast.example")).toBe("https://haulcast.example");
  });

  it("is no origin when the value is blank", async () => {
    const onOldEngine = await siteOriginOnAnOldEngine();

    expect(onOldEngine(" \t\n")).toBeUndefined();
  });

  it.each(["haulcast.example", "localhost:3000", "/just/a/path", "https://"])(
    "fails loudly, naming the value, when %j is not an absolute URL",
    async (value) => {
      const onOldEngine = await siteOriginOnAnOldEngine();

      expect(() => onOldEngine(value)).toThrow(
        `VITE_SITE_URL must be an absolute URL such as https://haulcast.example, got "${value}"`,
      );
    },
  );
});
