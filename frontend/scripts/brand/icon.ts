/** The brand colours of the icon: the ink of the interface on its paper (DESIGN.md section 3). */
const INK = "#161613";
const PAPER = "#F6F6F3";

/** Options of {@link iconSvg}. */
export interface IconOptions {
  /** Rounded corners for a browser tab or a launcher icon; square for an Apple touch icon (the phone rounds it). */
  readonly rounded: boolean;
}

/**
 * The Haulcast mark: a route with four checkpoints on an ink tile, drawn the way the map draws a
 * route (a paper line with ringed markers). A hairline of paper keeps the tile visible on a dark
 * tab strip. No text, so it needs no font.
 */
export function iconSvg({ rounded }: IconOptions): string {
  const tile = rounded
    ? `<rect x="1" y="1" width="62" height="62" rx="14" fill="${INK}" stroke="${PAPER}" stroke-width="2"/>`
    : `<rect width="64" height="64" fill="${INK}"/>`;
  const stops = [
    [12, 49],
    [25, 33],
    [40, 41],
    [52, 15],
  ] as const;
  const markers = stops
    .map(
      ([x, y]) =>
        `<circle cx="${String(x)}" cy="${String(y)}" r="4.5" fill="${PAPER}" stroke="${INK}" stroke-width="2.5"/>`,
    )
    .join("");
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">',
    tile,
    `<path d="M12 49 L25 33 L40 41 L52 15" fill="none" stroke="${PAPER}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`,
    markers,
    "</svg>",
    "",
  ].join("\n");
}

/** The sizes the icon is rendered at, each with the file it goes to and whether the tile is rounded. */
export const ICON_FILES = [
  { file: "favicon-32.png", size: 32, rounded: true },
  { file: "icon-192.png", size: 192, rounded: true },
  { file: "icon-512.png", size: 512, rounded: true },
  { file: "apple-touch-icon.png", size: 180, rounded: false },
] as const;

/**
 * An `.ico` file holding one PNG image, which every browser since 2008 reads. Only the 32 pixel
 * icon goes in: it is what an old browser asks `/favicon.ico` for.
 */
export function pngToIco(png: Uint8Array, size: number): Uint8Array {
  const header = new DataView(new ArrayBuffer(22));
  header.setUint16(2, 1, true); // image type: icon
  header.setUint16(4, 1, true); // one image
  header.setUint8(6, size); // width
  header.setUint8(7, size); // height
  header.setUint16(10, 1, true); // colour planes
  header.setUint16(12, 32, true); // bits per pixel
  header.setUint32(14, png.byteLength, true);
  header.setUint32(18, 22, true); // where the image starts
  const ico = new Uint8Array(22 + png.byteLength);
  ico.set(new Uint8Array(header.buffer), 0);
  ico.set(png, 22);
  return ico;
}
