import { afterEach, describe, expect, it, vi } from "vitest";

import { markerCanvasSize } from "./icons";
import { renderMarkerImage } from "./marker-image";

/** Enough of a 2D context for `drawMarker`, plus `getImageData`. */
function fakeContext(scale: (x: number, y: number) => void): CanvasRenderingContext2D {
  const noop = (): void => undefined;
  const context = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineJoin: "miter",
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    scale,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    fillText: noop,
    setLineDash: noop,
    getImageData: (_x: number, _y: number, width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
  };
  return context as unknown as CanvasRenderingContext2D;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderMarkerImage", () => {
  it("draws on a canvas sized for the pixel ratio and returns its pixels", () => {
    const scale = vi.fn();
    const context = fakeContext(scale);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);

    const image = renderMarkerImage("severe", "light", 2);

    const size = Math.ceil(markerCanvasSize("severe") * 2);
    expect(image.width).toBe(size);
    expect(image.height).toBe(size);
    expect(image.data).toHaveLength(size * size * 4);
    expect(scale).toHaveBeenCalledWith(2, 2);
  });

  it("fails loudly when the browser has no 2D canvas", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

    expect(() => renderMarkerImage("low", "dark", 1)).toThrow(/no 2D canvas/);
  });
});
