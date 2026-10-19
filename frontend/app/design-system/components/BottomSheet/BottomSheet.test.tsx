import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { copy } from "../../copy";
import { BottomSheet, type SheetSnap } from "./BottomSheet";
import BottomSheetDemo from "./BottomSheet.demo";

const LABEL = copy.app.regions.planner;
/** An 800 px viewport: peek 112 px, half 400 px, full 744 px (the sheet box is 744 px tall). */
const VIEWPORT = 800;
const FULL_HEIGHT = 744;

function rect(height: number): DOMRect {
  return {
    x: 0,
    y: VIEWPORT - height,
    top: VIEWPORT - height,
    left: 0,
    right: 390,
    bottom: VIEWPORT,
    width: 390,
    height,
    toJSON: () => ({}),
  };
}

/** jsdom has no layout: give the sheet a viewport and a box, and the peek its resolved min-height. */
function stubLayout(): void {
  vi.stubGlobal("innerHeight", VIEWPORT);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect(FULL_HEIGHT));
}

function sheet(): HTMLElement {
  const element = screen.getByRole("region", { name: LABEL });
  element.style.minHeight = "112px";
  return element;
}

function handle(): HTMLElement {
  return screen.getByRole("button", {
    name: new RegExp(`${copy.sheet.handle.expand}|${copy.sheet.handle.collapse}`),
  });
}

function renderSheet(
  props: { defaultSnap?: SheetSnap; onSnapChange?: (snap: SheetSnap) => void } = {},
) {
  const view = render(
    <BottomSheet label={LABEL} {...props}>
      <p>Sheet content</p>
    </BottomSheet>,
  );
  return view;
}

const touch = { pointerId: 1, pointerType: "touch" } as const;
const down = (y: number): boolean =>
  fireEvent.pointerDown(handle(), { ...touch, button: 0, clientY: y });
const move = (y: number): boolean => fireEvent.pointerMove(window, { ...touch, clientY: y });
const up = (y: number): boolean => fireEvent.pointerUp(window, { ...touch, clientY: y });
const wait = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

describe("BottomSheet", () => {
  describe("structure", () => {
    it("is a named region that holds the content and a handle button", () => {
      renderSheet();

      expect(screen.getByRole("region", { name: LABEL })).toContainElement(
        screen.getByText("Sheet content"),
      );
      expect(handle()).toBeInTheDocument();
    });

    it("opens at half by default and offers to expand", () => {
      renderSheet();

      expect(handle()).toHaveAttribute("aria-expanded", "true");
      expect(handle()).toHaveAccessibleName(copy.sheet.handle.expand);
    });

    it.each<[SheetSnap, string, string]>([
      ["peek", "false", copy.sheet.handle.expand],
      ["half", "true", copy.sheet.handle.expand],
      ["full", "true", copy.sheet.handle.collapse],
    ])("starts at %s with aria-expanded %s and the %s action", (snap, expanded, name) => {
      renderSheet({ defaultSnap: snap });

      expect(handle()).toHaveAttribute("aria-expanded", expanded);
      expect(handle()).toHaveAccessibleName(name);
    });

    it("keeps the content scrollable at every snap by never hiding it", () => {
      renderSheet({ defaultSnap: "peek" });

      expect(screen.getByText("Sheet content")).toBeVisible();
    });
  });

  describe("tapping the handle", () => {
    it("cycles peek, half, full, half, peek and relabels the handle each time", async () => {
      const user = userEvent.setup();
      const onSnapChange = vi.fn();
      renderSheet({ defaultSnap: "peek", onSnapChange });
      const expected: [SheetSnap, string, string][] = [
        ["half", "true", copy.sheet.handle.expand],
        ["full", "true", copy.sheet.handle.collapse],
        ["half", "true", copy.sheet.handle.collapse],
        ["peek", "false", copy.sheet.handle.expand],
        ["half", "true", copy.sheet.handle.expand],
      ];

      for (const [snap, expanded, name] of expected) {
        await user.click(handle());
        expect(onSnapChange).toHaveBeenLastCalledWith(snap);
        expect(handle()).toHaveAttribute("aria-expanded", expanded);
        expect(handle()).toHaveAccessibleName(name);
      }
      expect(onSnapChange).toHaveBeenCalledTimes(5);
    });
  });

  describe("keyboard on the handle", () => {
    it("steps up with ArrowUp and stops at full", async () => {
      const user = userEvent.setup();
      const onSnapChange = vi.fn();
      renderSheet({ defaultSnap: "peek", onSnapChange });
      handle().focus();

      await user.keyboard("{ArrowUp}");
      await user.keyboard("{ArrowUp}");
      await user.keyboard("{ArrowUp}");

      expect(onSnapChange.mock.calls).toEqual([["half"], ["full"]]);
    });

    it("steps down with ArrowDown and stops at peek", async () => {
      const user = userEvent.setup();
      const onSnapChange = vi.fn();
      renderSheet({ defaultSnap: "full", onSnapChange });
      handle().focus();

      await user.keyboard("{ArrowDown}");
      await user.keyboard("{ArrowDown}");
      await user.keyboard("{ArrowDown}");

      expect(onSnapChange.mock.calls).toEqual([["half"], ["peek"]]);
    });

    it("jumps to peek with Home and to full with End, reporting only real changes", async () => {
      const user = userEvent.setup();
      const onSnapChange = vi.fn();
      renderSheet({ onSnapChange });
      handle().focus();

      await user.keyboard("{Home}");
      await user.keyboard("{Home}");
      await user.keyboard("{End}");
      await user.keyboard("{End}");

      expect(onSnapChange.mock.calls).toEqual([["peek"], ["full"]]);
    });

    it("cycles with Enter and with Space", async () => {
      const user = userEvent.setup();
      const onSnapChange = vi.fn();
      renderSheet({ defaultSnap: "peek", onSnapChange });
      handle().focus();

      await user.keyboard("{Enter}");
      await user.keyboard(" ");

      expect(onSnapChange.mock.calls).toEqual([["half"], ["full"]]);
    });

    it("ignores other keys", async () => {
      const user = userEvent.setup();
      const onSnapChange = vi.fn();
      renderSheet({ onSnapChange });
      handle().focus();

      await user.keyboard("a");
      await user.keyboard("{ArrowLeft}");

      expect(onSnapChange).not.toHaveBeenCalled();
    });

    it("is reachable with Tab and shows keyboard focus", async () => {
      const user = userEvent.setup();
      renderSheet();

      await user.tab();

      expect(handle()).toHaveFocus();
      expect(handle()).toHaveAttribute("data-focus-visible", "true");
    });
  });

  describe("controlled and uncontrolled", () => {
    it("follows the snap prop and only reports the request", async () => {
      const user = userEvent.setup();
      const onSnapChange = vi.fn();
      const { rerender } = render(
        <BottomSheet label={LABEL} snap="peek" onSnapChange={onSnapChange}>
          <p>Sheet content</p>
        </BottomSheet>,
      );

      await user.click(handle());

      expect(onSnapChange).toHaveBeenCalledWith("half");
      expect(handle()).toHaveAttribute("aria-expanded", "false");

      rerender(
        <BottomSheet label={LABEL} snap="full" onSnapChange={onSnapChange}>
          <p>Sheet content</p>
        </BottomSheet>,
      );
      expect(handle()).toHaveAttribute("aria-expanded", "true");
      expect(handle()).toHaveAccessibleName(copy.sheet.handle.collapse);
    });

    it("works controlled from a parent that applies every change", async () => {
      const user = userEvent.setup();
      function Controlled(): ReactElement {
        const [snap, setSnap] = useState<SheetSnap>("peek");
        return (
          <BottomSheet label={LABEL} snap={snap} onSnapChange={setSnap}>
            <p>Sheet content</p>
          </BottomSheet>
        );
      }
      render(<Controlled />);

      await user.click(handle());
      await user.click(handle());

      expect(handle()).toHaveAccessibleName(copy.sheet.handle.collapse);
    });

    it("works uncontrolled without any callback", async () => {
      const user = userEvent.setup();
      render(
        <BottomSheet label={LABEL} defaultSnap="peek">
          <p>Sheet content</p>
        </BottomSheet>,
      );

      await user.click(handle());

      expect(handle()).toHaveAttribute("aria-expanded", "true");
    });
  });

  describe("live region", () => {
    it("is silent until the snap changes", () => {
      renderSheet();

      expect(screen.getByRole("status")).toBeEmptyDOMElement();
    });

    it.each<[string, SheetSnap, string]>([
      ["{Home}", "peek", copy.status.sheet.peek],
      ["{ArrowDown}", "peek", copy.status.sheet.peek],
      ["{End}", "full", copy.status.sheet.full],
    ])("announces the new snap after %s", async (keys, _snap, text) => {
      const user = userEvent.setup();
      renderSheet();
      handle().focus();

      await user.keyboard(keys);

      expect(screen.getByRole("status")).toHaveTextContent(text);
      expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    });

    it("announces half when the sheet returns to the middle", async () => {
      const user = userEvent.setup();
      renderSheet({ defaultSnap: "full" });
      handle().focus();

      await user.keyboard("{ArrowDown}");

      expect(screen.getByRole("status")).toHaveTextContent(copy.status.sheet.half);
    });

    it("announces a snap change that came from the parent", () => {
      const { rerender } = render(
        <BottomSheet label={LABEL} snap="half">
          <p>Sheet content</p>
        </BottomSheet>,
      );

      rerender(
        <BottomSheet label={LABEL} snap="full">
          <p>Sheet content</p>
        </BottomSheet>,
      );

      expect(screen.getByRole("status")).toHaveTextContent(copy.status.sheet.full);
    });
  });

  describe("dock", () => {
    function renderWithDock(defaultSnap: SheetSnap) {
      return render(
        <BottomSheet
          label={LABEL}
          defaultSnap={defaultSnap}
          dock={
            <div role="group" aria-label="Timeline dock">
              <input aria-label="Dock note" />
            </div>
          }
        >
          <p>Sheet content</p>
        </BottomSheet>,
      );
    }

    it.each<SheetSnap>(["peek", "half"])("shows the dock at %s", (snap) => {
      renderWithDock(snap);

      expect(screen.getByRole("group", { name: "Timeline dock" })).toBeVisible();
    });

    it("hides the dock at full and keeps its state for the way back", async () => {
      const user = userEvent.setup();
      renderWithDock("half");
      await user.type(screen.getByRole("textbox", { name: "Dock note" }), "keep me");
      handle().focus();

      await user.keyboard("{End}");
      expect(screen.queryByRole("group", { name: "Timeline dock" })).not.toBeInTheDocument();

      await user.keyboard("{Home}");
      expect(screen.getByRole("textbox", { name: "Dock note" })).toHaveValue("keep me");
    });

    it("renders no dock when none is given", () => {
      renderSheet();

      expect(screen.queryByRole("group")).not.toBeInTheDocument();
    });
  });

  describe("dragging the handle", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      stubLayout();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("follows the finger without a transition and settles back when released in place", () => {
      renderSheet();
      sheet();

      down(500);
      move(470);
      wait(16);

      expect(sheet()).toHaveAttribute("data-dragging");
      expect(sheet().style.transform).toBe("translateY(calc(var(--sheet-offset) + -30px))");

      wait(500);
      up(470);

      expect(sheet()).not.toHaveAttribute("data-dragging");
      expect(sheet().style.transform).toBe("");
    });

    it.each<[string, SheetSnap, number, SheetSnap]>([
      ["half up past the middle of the way to full", "half", -250, "full"],
      ["half up a little", "half", -50, "half"],
      ["half down far", "half", 200, "peek"],
      ["half down a little", "half", 50, "half"],
      ["peek up far", "peek", -250, "half"],
      ["peek up a little", "peek", -50, "peek"],
      ["full down far", "full", 500, "peek"],
      ["full down a little", "full", 100, "full"],
    ])("releases slowly from %s to the nearest snap", (_name, start, travel, expected) => {
      const onSnapChange = vi.fn();
      renderSheet({ defaultSnap: start, onSnapChange });
      sheet();

      down(500);
      move(500 + travel / 2);
      wait(400);
      move(500 + travel);
      wait(400);
      up(500 + travel);

      expect(handle()).toHaveAttribute("aria-expanded", expected === "peek" ? "false" : "true");
      if (expected === start) {
        expect(onSnapChange).not.toHaveBeenCalled();
      } else {
        expect(onSnapChange).toHaveBeenCalledExactlyOnceWith(expected);
      }
    });

    it("flings up to the next snap even when the nearest one is where it started", () => {
      const onSnapChange = vi.fn();
      renderSheet({ onSnapChange });
      sheet();

      down(500);
      move(490);
      wait(10);
      move(470);
      wait(5);
      up(470);

      expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("full");
    });

    it("flings down to the next snap even when the nearest one is where it started", () => {
      const onSnapChange = vi.fn();
      renderSheet({ onSnapChange });
      sheet();

      down(500);
      move(510);
      wait(10);
      move(530);
      wait(5);
      up(530);

      expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("peek");
    });

    it("flings from peek to half and from full to half", () => {
      const onSnapChange = vi.fn();
      const { unmount } = renderSheet({ defaultSnap: "peek", onSnapChange });
      sheet();

      down(500);
      move(480);
      wait(10);
      move(460);
      wait(5);
      up(460);
      expect(onSnapChange).toHaveBeenLastCalledWith("half");
      unmount();

      renderSheet({ defaultSnap: "full", onSnapChange });
      sheet();
      down(100);
      move(120);
      wait(10);
      move(140);
      wait(5);
      up(140);
      expect(onSnapChange).toHaveBeenLastCalledWith("half");
    });

    it("does not fling when the finger rested before it lifted", () => {
      const onSnapChange = vi.fn();
      renderSheet({ onSnapChange });
      sheet();

      down(500);
      move(490);
      wait(10);
      move(470);
      wait(400);
      up(470);

      expect(onSnapChange).not.toHaveBeenCalled();
    });

    it("stops at full when dragged beyond it, and at peek when dragged below it", () => {
      renderSheet();
      sheet();

      down(700);
      move(-3000);
      wait(400);
      expect(sheet().style.transform).toBe("translateY(calc(var(--sheet-offset) + -344px))");
      move(9000);
      wait(400);
      expect(sheet().style.transform).toBe("translateY(calc(var(--sheet-offset) + 288px))");
      up(9000);
    });

    it("does not turn the click that follows a drag into a tap", () => {
      const onSnapChange = vi.fn();
      renderSheet({ onSnapChange });
      sheet();

      down(500);
      move(450);
      wait(500);
      up(450);
      onSnapChange.mockClear();
      fireEvent.click(handle());

      expect(onSnapChange).not.toHaveBeenCalled();
    });

    it("lets a new tap through after a drag whose click never arrived", () => {
      const onSnapChange = vi.fn();
      renderSheet({ onSnapChange });
      sheet();
      down(500);
      move(450);
      wait(500);
      up(450);
      onSnapChange.mockClear();

      down(500);
      up(500);
      fireEvent.click(handle());

      expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("full");
    });

    it("treats a press and release without movement as a tap", () => {
      const onSnapChange = vi.fn();
      renderSheet({ defaultSnap: "peek", onSnapChange });

      down(500);
      up(500);
      fireEvent.click(handle());

      expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("half");
      expect(handle()).not.toHaveAttribute("data-dragging");
    });

    it("keeps working after a controlled parent ignores the snap request", () => {
      render(
        <BottomSheet label={LABEL} snap="half" onSnapChange={() => undefined}>
          <p>Sheet content</p>
        </BottomSheet>,
      );
      sheet();

      down(500);
      move(250);
      wait(500);
      up(250);

      expect(handle()).toHaveAttribute("aria-expanded", "true");
      expect(sheet().style.transform).toBe("");
    });
  });

  describe("styling contract", () => {
    const css = readFileSync(join(import.meta.dirname, "BottomSheet.module.css"), "utf8");

    it("animates the snap with the sheet duration and standard easing tokens", () => {
      expect(css).toMatch(
        /transition:\s*transform\s+var\(--motion-duration-sheet\)\s+var\(--motion-easing-standard\)/,
      );
    });

    it("never hard-codes a duration", () => {
      expect(css).not.toMatch(/\d(ms|s)\b/);
    });
  });

  describe("accessibility (axe)", () => {
    it("has no violations at peek, half and full, with a dock", async () => {
      const { container } = render(
        <BottomSheet
          label={LABEL}
          defaultSnap="peek"
          dock={
            <div role="group" aria-label="Timeline dock">
              Dock
            </div>
          }
        >
          <p>Sheet content</p>
        </BottomSheet>,
      );
      await expectNoAxeViolations(container);
      const user = userEvent.setup();
      handle().focus();

      await user.keyboard("{ArrowUp}");
      await expectNoAxeViolations(container);
      await user.keyboard("{ArrowUp}");
      await expectNoAxeViolations(container);
    });

    it("has no violations in the demo", async () => {
      const { container } = render(<BottomSheetDemo />);

      await expectNoAxeViolations(container);
    });
  });

  describe("demo", () => {
    it("shows the snap the sheet is at and follows it", async () => {
      const user = userEvent.setup();
      render(<BottomSheetDemo />);
      screen.getByRole("button", { name: copy.sheet.handle.expand }).focus();

      await user.keyboard("{End}");

      expect(screen.getByText(/Snap: full/)).toBeInTheDocument();
    });

    it("can be driven from outside through its snap buttons", async () => {
      const user = userEvent.setup();
      render(<BottomSheetDemo />);

      await user.click(screen.getByRole("button", { name: "Peek" }));
      expect(screen.getByText(/Snap: peek/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Half" }));
      expect(screen.getByText(/Snap: half/)).toBeInTheDocument();
    });
  });
});
