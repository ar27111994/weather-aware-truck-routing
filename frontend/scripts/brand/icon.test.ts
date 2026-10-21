import { describe, expect, it } from "vitest";

import { ICON_FILES, iconSvg, pngToIco } from "./icon";

describe("iconSvg", () => {
  it("draws a route with four checkpoints on an ink tile, with no text", () => {
    const svg = iconSvg({ rounded: true });

    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"')).toBe(
      true,
    );
    expect(svg.match(/<circle /gu)).toHaveLength(4);
    expect(svg).not.toContain("<text");
    expect(svg.endsWith("</svg>\n")).toBe(true);
  });

  it("rounds the tile for a tab and squares it for an Apple touch icon", () => {
    expect(iconSvg({ rounded: true })).toContain('rx="14"');
    expect(iconSvg({ rounded: false })).not.toContain("rx=");
  });
});

describe("ICON_FILES", () => {
  it("names a file for each size the page and the manifest ask for", () => {
    expect(ICON_FILES.map(({ file, size }) => [file, size])).toEqual([
      ["favicon-32.png", 32],
      ["icon-192.png", 192],
      ["icon-512.png", 512],
      ["apple-touch-icon.png", 180],
    ]);
  });

  it("squares only the Apple touch icon", () => {
    expect(ICON_FILES.filter(({ rounded }) => !rounded).map(({ file }) => file)).toEqual([
      "apple-touch-icon.png",
    ]);
  });
});

describe("pngToIco", () => {
  it("wraps one PNG in an icon file that says where the image starts and how long it is", () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

    const ico = pngToIco(png, 32);

    const view = new DataView(ico.buffer);
    expect(ico.byteLength).toBe(22 + png.byteLength);
    expect(view.getUint16(2, true)).toBe(1);
    expect(view.getUint16(4, true)).toBe(1);
    expect([view.getUint8(6), view.getUint8(7)]).toEqual([32, 32]);
    expect(view.getUint32(14, true)).toBe(png.byteLength);
    expect(view.getUint32(18, true)).toBe(22);
    expect([...ico.slice(22)]).toEqual([...png]);
  });
});
