// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ICON_FILES, iconSvg } from "./icon";

const PUBLIC = new URL("../../public/", import.meta.url);
const read = (name: string): Buffer => readFileSync(new URL(name, PUBLIC));

/** Width and height from the IHDR chunk of a PNG file. */
function pngSize(name: string): readonly [number, number] {
  const file = read(name);
  expect(file.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return [file.readUInt32BE(16), file.readUInt32BE(20)];
}

describe("the brand files that are committed to public/", () => {
  it("has an Open Graph image of 1200 by 630 pixels", () => {
    expect(pngSize("og.png")).toEqual([1200, 630]);
  });

  it.each(ICON_FILES.map(({ file, size }) => [file, size] as const))(
    "has %s at %i pixels square",
    (file, size) => {
      expect(pngSize(file)).toEqual([size, size]);
    },
  );

  it("has the favicon as the SVG the script draws, so the two cannot drift", () => {
    expect(read("favicon.svg").toString("utf8")).toBe(iconSvg({ rounded: true }));
  });

  it("has a favicon.ico that holds the 32 pixel icon", () => {
    const ico = read("favicon.ico");

    expect([ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([1, 1]);
    expect(ico.subarray(22).equals(read("favicon-32.png"))).toBe(true);
  });

  it("has a web manifest whose icons are files that exist, at the sizes it says", () => {
    const manifest = JSON.parse(read("manifest.webmanifest").toString("utf8")) as {
      name: string;
      start_url: string;
      icons: { src: string; sizes: string; type: string }[];
    };

    expect(manifest.name).toBe("Haulcast");
    expect(manifest.start_url).toBe("/");
    for (const icon of manifest.icons) {
      if (icon.type === "image/png") {
        const size = Number(icon.sizes.split("x")[0]);
        expect(pngSize(icon.src.slice(1))).toEqual([size, size]);
      } else {
        expect(read(icon.src.slice(1)).byteLength).toBeGreaterThan(0);
      }
    }
  });
});
