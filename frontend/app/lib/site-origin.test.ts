import { describe, expect, it } from "vitest";

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
