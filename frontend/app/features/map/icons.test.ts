import { describe, expect, it } from "vitest";

import { MARKER_PADDING, MARKER_SIZE, drawMarker, markerCanvasSize, markerImageId } from "./icons";
import type { MarkerContext } from "./icons";
import { MAP_RISK_KEYS, palette, riskFill, riskOnFill, riskStroke } from "./symbology";

/** Records every drawing call, with the style that was current at that moment. */
function recorder(): MarkerContext & { readonly calls: string[] } {
  const calls: string[] = [];
  const state = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineJoin: "miter" as CanvasLineJoin,
    font: "",
    textAlign: "start" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
  };
  return {
    calls,
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(value: string) {
      state.fillStyle = value;
    },
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(value: string) {
      state.strokeStyle = value;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(value: number) {
      state.lineWidth = value;
    },
    get lineJoin() {
      return state.lineJoin;
    },
    set lineJoin(value: CanvasLineJoin) {
      state.lineJoin = value;
    },
    get font() {
      return state.font;
    },
    set font(value: string) {
      state.font = value;
    },
    get textAlign() {
      return state.textAlign;
    },
    set textAlign(value: CanvasTextAlign) {
      state.textAlign = value;
    },
    get textBaseline() {
      return state.textBaseline;
    },
    set textBaseline(value: CanvasTextBaseline) {
      state.textBaseline = value;
    },
    scale: (x, y) => calls.push(`scale ${String(x)} ${String(y)}`),
    beginPath: () => calls.push("beginPath"),
    closePath: () => calls.push("closePath"),
    moveTo: (x, y) => calls.push(`moveTo ${x.toFixed(2)} ${y.toFixed(2)}`),
    lineTo: (x, y) => calls.push(`lineTo ${x.toFixed(2)} ${y.toFixed(2)}`),
    arc: (x, y, r) => calls.push(`arc ${x.toFixed(2)} ${y.toFixed(2)} ${r.toFixed(2)}`),
    fill: () => calls.push(`fill ${state.fillStyle}`),
    stroke: () => calls.push(`stroke ${state.strokeStyle} ${String(state.lineWidth)}`),
    fillRect: (x, y, w, h) =>
      calls.push(`fillRect ${state.fillStyle} ${String(x)} ${String(y)} ${String(w)} ${String(h)}`),
    fillText: (text) => calls.push(`fillText ${state.fillStyle} ${text}`),
    setLineDash: (segments) => calls.push(`dash ${Array.from(segments).join(",")}`),
  };
}

describe("marker images", () => {
  it("grow with severity so the eye finds danger first (DESIGN.md section 4)", () => {
    expect(MARKER_SIZE).toEqual({
      low: 12,
      moderate: 16,
      high: 18,
      severe: 18,
      no_travel: 22,
      unknown: 14,
    });
    expect(markerCanvasSize("no_travel")).toBe(22 + MARKER_PADDING);
  });

  it("are named hc-cp-<level>, the name the symbol layer asks for", () => {
    expect(markerImageId("no_travel")).toBe("hc-cp-no_travel");
  });

  it("are filled with the level's colour, outlined in its stroke, inside a 1 px ink hairline", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const key of MAP_RISK_KEYS) {
        const ctx = recorder();

        drawMarker(ctx, key, theme, 2);

        const ink = palette(theme)["map-route-outline-selected"];
        expect(ctx.calls[0]).toBe("scale 2 2");
        expect(ctx.calls).toContain(`fill ${riskFill(theme, key)}`);
        expect(ctx.calls).toContain(`stroke ${riskStroke(theme, key)} 2`);
        expect(ctx.calls).toContain(`stroke ${ink} 4`);
        // The hairline is drawn first, so the fill and stroke cover its inner half.
        expect(ctx.calls.findIndex((call) => call.startsWith(`stroke ${ink}`))).toBeLessThan(
          ctx.calls.indexOf(`fill ${riskFill(theme, key)}`),
        );
      }
    }
  });

  it("draws a different outline for every level, so shape alone tells them apart", () => {
    const outlines = MAP_RISK_KEYS.map((key) => {
      const ctx = recorder();
      drawMarker(ctx, key, "light", 1);
      return ctx.calls
        .filter((call) => /^(moveTo|lineTo|arc)/.test(call))
        .slice(0, 9)
        .join("|");
    });

    expect(new Set(outlines).size).toBe(MAP_RISK_KEYS.length);
  });

  it("puts a bar across No Travel and a question mark in a dashed Unknown ring, in the on-fill colour", () => {
    const noTravel = recorder();
    drawMarker(noTravel, "no_travel", "dark", 1);
    const unknown = recorder();
    drawMarker(unknown, "unknown", "dark", 1);

    expect(
      noTravel.calls.some((call) => call.startsWith(`fillRect ${riskOnFill("dark", "no_travel")}`)),
    ).toBe(true);
    expect(unknown.calls).toContain(`fillText ${riskOnFill("dark", "unknown")} ?`);
    expect(unknown.calls.some((call) => call.startsWith("dash ") && call !== "dash ")).toBe(true);
    // The dash is reset afterwards, so nothing drawn after it comes out dashed.
    expect(unknown.calls).toContain("dash ");
  });
});
