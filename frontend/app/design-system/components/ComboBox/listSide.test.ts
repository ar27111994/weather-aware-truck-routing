import { describe, expect, it, vi } from "vitest";

import { MIN_ROOM_BELOW, listSideFor } from "./listSide";

const HEIGHT = 44;

/** An input whose top edge is `top` px from the top of the viewport. */
function inputAt(top: number): HTMLInputElement {
  const input = document.createElement("input");
  vi.spyOn(input, "getBoundingClientRect").mockReturnValue(new DOMRect(0, top, 300, HEIGHT));
  return input;
}

/** A page without a visual viewport, whose layout viewport is `height` px tall. */
function stubLayoutViewport(height: number): void {
  vi.stubGlobal("visualViewport", undefined);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(height);
}

/** The top edge of an input that has `room` px below it in a viewport of `height` px. */
const topWithRoomBelow = (height: number, room: number): number => height - HEIGHT - room;

describe("listSideFor", () => {
  it("opens below when there is no input to measure", () => {
    expect(listSideFor(null)).toBe("bottom");
  });

  it("opens below when the room below holds a list", () => {
    stubLayoutViewport(700);

    expect(listSideFor(inputAt(100))).toBe("bottom");
  });

  it("opens above when the room below is short and the room above is larger", () => {
    stubLayoutViewport(700);

    expect(listSideFor(inputAt(topWithRoomBelow(700, MIN_ROOM_BELOW - 1)))).toBe("top");
  });

  it("opens below at exactly the room that a list needs", () => {
    stubLayoutViewport(700);

    expect(listSideFor(inputAt(topWithRoomBelow(700, MIN_ROOM_BELOW)))).toBe("bottom");
  });

  it("opens below when the room below is short and the room above is no larger", () => {
    // 40 px above the input and 40 px below it: nothing is gained by crossing the input.
    stubLayoutViewport(40 + HEIGHT + 40);

    expect(listSideFor(inputAt(40))).toBe("bottom");
  });

  it("measures from the visual viewport, its offset included, when the page has one", () => {
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(700);
    // The visible part is 300 px tall and starts 100 px down: 106 px below the input, 150 above.
    vi.stubGlobal("visualViewport", { offsetTop: 100, height: 300 });

    expect(listSideFor(inputAt(250))).toBe("top");
  });
});
