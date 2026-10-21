/**
 * `pnpm brand` renders the files a browser, a phone and a link preview ask for: the Open Graph
 * image (`og.png`, 1200 by 630) from `scripts/brand/og.html`, and the favicon in every size from
 * the icon in `scripts/brand/icon.ts`. The results are committed to `public/`; run this again
 * after a change to the tokens, the template or the icon.
 *
 * Process wrapper only: the rules live in `brand/icon.ts` and `brand/og.ts`, which the unit tests
 * cover, and a test reads the committed files back (sizes, icon source, no drift). It needs a
 * browser to draw, so it runs headless (never a window) on the Chromium that Playwright installs.
 */
import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { ICON_FILES, iconSvg, pngToIco } from "./brand/icon.ts";
import { buildOgHtml } from "./brand/og.ts";

const ROOT = new URL("../", import.meta.url);
const PUBLIC = new URL("public/", ROOT);
const read = (path: string): Promise<Buffer> => readFile(new URL(path, ROOT));
const FONT_DIR = "node_modules/@fontsource-variable";

await mkdir(PUBLIC, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });

  const template = (await read("scripts/brand/og.html")).toString("utf8");
  const html = buildOgHtml(template, {
    tokens: (await read("app/design-system/tokens/tokens.css")).toString("utf8"),
    fonts: {
      sans: await read(`${FONT_DIR}/overpass/files/overpass-latin-wght-normal.woff2`),
      mono: await read(`${FONT_DIR}/overpass-mono/files/overpass-mono-latin-wght-normal.woff2`),
    },
  });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await writeFile(new URL("og.png", PUBLIC), await page.screenshot({ type: "png" }));

  await writeFile(new URL("favicon.svg", PUBLIC), iconSvg({ rounded: true }), "utf8");
  for (const { file, size, rounded } of ICON_FILES) {
    const svg = Buffer.from(iconSvg({ rounded })).toString("base64");
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}img{display:block}</style><img width="${String(size)}" height="${String(size)}" src="data:image/svg+xml;base64,${svg}" alt="">`,
    );
    const png = await page.screenshot({ type: "png", omitBackground: true });
    await writeFile(new URL(file, PUBLIC), png);
    if (file === "favicon-32.png") {
      await writeFile(new URL("favicon.ico", PUBLIC), pngToIco(png, size));
    }
  }
} finally {
  await browser.close();
}
console.log("Rendered the Open Graph image and the icons into frontend/public/.");
