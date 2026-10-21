import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildOgHtml } from "./og";

const parts = {
  tokens: ":root { --test-token: 1; }",
  fonts: { sans: new Uint8Array([1, 2, 3]), mono: new Uint8Array([4, 5, 6]) },
};

describe("buildOgHtml", () => {
  it("puts the tokens and both fonts, as data URLs, where the template says", () => {
    const html = buildOgHtml("<style>/*FONTS*/</style><style>/*TOKENS*/</style>", parts);

    expect(html).toContain(":root { --test-token: 1; }");
    expect(html).toContain(
      'font-family: "Overpass Variable"; src: url("data:font/woff2;base64,AQID")',
    );
    expect(html).toContain(
      'font-family: "Overpass Mono Variable"; src: url("data:font/woff2;base64,BAUG")',
    );
    expect(html).not.toContain("/*FONTS*/");
    expect(html).not.toContain("/*TOKENS*/");
  });

  it("is not fooled by a dollar sign in the tokens", () => {
    expect(buildOgHtml("/*FONTS*//*TOKENS*/", { ...parts, tokens: "a $& b" })).toContain("a $& b");
  });

  it.each(["/*FONTS*/", "/*TOKENS*/"])("refuses a template with no %s placeholder", (missing) => {
    const template = ["/*FONTS*/", "/*TOKENS*/"]
      .filter((placeholder) => placeholder !== missing)
      .join("");

    expect(() => buildOgHtml(template, parts)).toThrow(
      `The Open Graph template has no ${missing} placeholder.`,
    );
  });

  it("has both placeholders in the template that is committed", () => {
    const template = readFileSync(new URL("og.html", import.meta.url), "utf8");

    expect(template).toContain("/*FONTS*/");
    expect(template).toContain("/*TOKENS*/");
    expect(() => buildOgHtml(template, parts)).not.toThrow();
  });
});
