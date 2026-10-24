import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Controlled } from "../../../../test/controlled";
import { defined } from "../../../../test/defined";
import { fakeTimerUser, installFakeTimers } from "../../../../test/fake-timers";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectPressedState,
} from "../../../../test/states";
import { t } from "../../foundation/strings";
import { BottomSheet, TAP_SLOP, type SheetSnap } from "./BottomSheet";
import { demo } from "./BottomSheet.demo";

const LABEL = t("app.regions.planner");
/** An 800 px viewport: peek 112 px, half 400 px, full 744 px (the sheet box is 744 px tall). */
const VIEWPORT = 800;
const FULL_HEIGHT = 744;
/** The demo mounts the sheet only on request: it is fixed to the viewport. */
const SHOW = "Show the sheet";
const HIDE = "Hide the sheet";

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

/** The handle is named by one fixed label at every snap point (DR1): the state is `aria-expanded`. */
function handle(): HTMLElement {
  return screen.getByRole("button", { name: t("sheet.handle.label") });
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
const move = (y: number, x = 0): boolean =>
  fireEvent.pointerMove(window, { ...touch, clientX: x, clientY: y });
/**
 * The pointer comes up on `target`, and the event bubbles to the document and the window, as it
 * does in a browser (React Aria's press listens on the document, `useMove` on the window). A finger
 * on the handle comes up on it, because the sheet follows the finger; a mouse that was dragged off
 * the handle comes up on the page.
 */
const up = (y: number, x = 0, target: Element = handle()): boolean =>
  fireEvent.pointerUp(target, { ...touch, clientX: x, clientY: y });
const upAway = (y: number, x = 0): boolean => up(y, x, document.body);
const cancel = (y: number, x = 0, target: Element = handle()): boolean =>
  fireEvent.pointerCancel(target, { ...touch, clientX: x, clientY: y });
/** The click a browser sends when a finger or a mouse button comes up on the handle: one counted. */
const pointerClick = (): boolean => fireEvent.click(handle(), { detail: 1 });
/** A click as a current engine makes it: a PointerEvent whose `pointerType` says what made it. */
const clickOf = (init: PointerEventInit): boolean =>
  fireEvent(
    handle(),
    new PointerEvent("click", { bubbles: true, cancelable: true, composed: true, ...init }),
  );
/** The click of `click()` and of most screen readers' activation: no pointer behind it, none counted. */
const virtualClick = (): boolean => fireEvent.click(handle(), { detail: 0 });
const wait = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};
/** Longer than any wait that React Aria's press makes for a click that may be on its way. */
const ANY_CLICK_IS_IN = 1000;

/** One move of a press, in px from where the last one left it: sideways (right is positive), then down. */
type Step = readonly [dx: number, dy: number];

/** One finger on the handle: it comes down at y 500, makes each move in turn, rests, and ends. */
function press(steps: readonly Step[], end: (y: number, x: number) => boolean = up): void {
  down(500);
  let x = 0;
  let y = 500;
  for (const [dx, dy] of steps) {
    x += dx;
    y += dy;
    move(y, x);
    wait(500);
  }
  end(y, x);
}

/** `px` moves of one pixel upwards each: no single move comes near the slop. */
function creep(px: number): Step[] {
  return Array.from({ length: px }, (): Step => [0, -1]);
}

/** The most whole px on each axis that a diagonal can have and stay inside the slop, and one more. */
const INSIDE_DIAGONAL = Math.floor(TAP_SLOP / Math.SQRT2);
const PAST_DIAGONAL = Math.ceil(TAP_SLOP / Math.SQRT2);

describe("BottomSheet", () => {
  describe("structure", () => {
    it("is a named region that holds the content and a handle button", () => {
      renderSheet();

      expect(screen.getByRole("region", { name: LABEL })).toContainElement(
        screen.getByText("Sheet content"),
      );
      expect(handle()).toBeInTheDocument();
    });

    it("opens at half by default, with the handle expanded", () => {
      renderSheet();

      expect(handle()).toHaveAttribute("aria-expanded", "true");
    });

    // APG Button pattern: a label that names the next action, next to aria-expanded, reads "Expand
    // panel, expanded" at half. The name is fixed and the state has one encoding (DR1).
    it.each<[SheetSnap, string]>([
      ["peek", "false"],
      ["half", "true"],
      ["full", "true"],
    ])("starts at %s with aria-expanded %s and the one fixed name", (snap, expanded) => {
      renderSheet({ defaultSnap: snap });

      const only = screen.getByRole("button");
      expect(only).toHaveAccessibleName("Resize panel");
      expect(only).toHaveAttribute("aria-expanded", expanded);
    });

    it("controls the content container that holds what the sheet shows", () => {
      renderSheet();

      const controlled = document.getElementById(defined(handle().getAttribute("aria-controls")));

      expect(controlled).not.toBe(screen.getByRole("region", { name: LABEL }));
      expect(controlled).toContainElement(screen.getByText("Sheet content"));
    });

    it("puts no inline style in the markup at rest, because the CSP forbids it", () => {
      const { container } = renderSheet();

      expect(container.querySelectorAll("[style]")).toHaveLength(0);
    });

    it("keeps the content scrollable at every snap by never hiding it", () => {
      renderSheet({ defaultSnap: "peek" });

      expect(screen.getByText("Sheet content")).toBeVisible();
    });

    // D-60: React Aria's press focuses the element that carries its props, when it makes the click
    // that WebKit leaves out. That element must be one that cannot take focus.
    it("carries the press on a surface that cannot take focus, with the handle inside it", () => {
      renderSheet();
      const surface = defined(handle().parentElement);

      surface.focus();

      expect(surface).not.toHaveFocus();
      expect(surface).not.toHaveAttribute("tabindex");
      expect(surface).toHaveAttribute("data-react-aria-pressable", "true");
      expect(handle()).not.toHaveAttribute("data-react-aria-pressable");
    });
  });

  describe("tapping the handle", () => {
    it("cycles peek, half, full, half, peek and keeps the handle's name each time", async () => {
      const user = userEvent.setup();
      const onSnapChange = vi.fn();
      renderSheet({ defaultSnap: "peek", onSnapChange });
      const expected: [SheetSnap, string][] = [
        ["half", "true"],
        ["full", "true"],
        ["half", "true"],
        ["peek", "false"],
        ["half", "true"],
      ];

      for (const [snap, expanded] of expected) {
        await user.click(handle());
        expect(onSnapChange).toHaveBeenLastCalledWith(snap);
        expect(handle()).toHaveAttribute("aria-expanded", expanded);
        expect(handle()).toHaveAccessibleName("Resize panel");
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

  describe("interaction states of the handle", () => {
    it("is hovered while the pointer rests on it", async () => {
      const user = userEvent.setup();
      renderSheet();

      await expectHoverState(user, handle());
    });

    it("is pressed while a pointer button is held down on it", async () => {
      const user = userEvent.setup();
      renderSheet();

      await expectPressedState(user, handle());
    });

    it("is not pressed by the secondary pointer button", async () => {
      const user = userEvent.setup();
      renderSheet();

      await user.pointer({ keys: "[MouseRight>]", target: handle() });

      expect(handle()).not.toHaveAttribute("data-pressed");
    });

    it("stops being pressed when the button comes up away from the handle (a drag)", async () => {
      const user = userEvent.setup();
      renderSheet();

      await user.pointer({ keys: "[MouseLeft>]", target: handle() });
      expect(handle()).toHaveAttribute("data-pressed", "true");
      await user.pointer({ target: document.body });
      await user.pointer({ keys: "[/MouseLeft]" });

      expect(handle()).not.toHaveAttribute("data-pressed");
    });

    it("stops being pressed when the pointer is cancelled", async () => {
      const user = userEvent.setup();
      renderSheet();

      await user.pointer({ keys: "[MouseLeft>]", target: handle() });
      expect(handle()).toHaveAttribute("data-pressed", "true");
      act(() => {
        window.dispatchEvent(new Event("pointercancel"));
      });

      expect(handle()).not.toHaveAttribute("data-pressed");
    });

    it("shows the focus ring when the keyboard puts focus on it", async () => {
      const user = userEvent.setup();
      renderSheet();

      await expectKeyboardFocusState(user, handle());
    });

    // A click is not asserted: useMove cancels the pointer-down, and under jsdom that means a click
    // never puts focus on the handle, so there is no focus whose ring could be left out.
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
    });

    it("works controlled from a parent that applies every change", async () => {
      const user = userEvent.setup();
      render(
        <Controlled<SheetSnap> initial="peek">
          {({ value, onChange }) => (
            <BottomSheet label={LABEL} snap={value} onSnapChange={onChange}>
              <p>Sheet content</p>
            </BottomSheet>
          )}
        </Controlled>,
      );

      await user.click(handle());
      await user.click(handle());

      expect(handle()).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("status")).toHaveTextContent(t("status.sheet.full"));
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

  describe("a focused control in the content when the snap changes", () => {
    // The content scrolls under the part of the sheet below the screen edge. Scroll padding reveals a
    // control when focus moves to it; it does not when the sheet moves under a resting focus (DR1).
    let scrollIntoView: MockInstance<Element["scrollIntoView"]>;
    beforeEach(() => {
      scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    });

    function renderWithField(defaultSnap: SheetSnap) {
      return render(
        <BottomSheet label={LABEL} defaultSnap={defaultSnap}>
          <input aria-label="Field" />
        </BottomSheet>,
      );
    }

    it("is scrolled into view, the nearest edge, after a tap on the handle moves the sheet", async () => {
      const user = userEvent.setup();
      renderWithField("peek");
      const field = screen.getByRole("textbox", { name: "Field" });
      field.focus();

      await user.click(handle());

      expect(field).toHaveFocus();
      expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
      expect(scrollIntoView.mock.contexts[0]).toBe(field);
    });

    it("is scrolled into view when the parent moves the sheet", () => {
      const sheetWith = (snap: SheetSnap): ReactElement => (
        <BottomSheet label={LABEL} snap={snap}>
          <input aria-label="Field" />
        </BottomSheet>
      );
      const { rerender } = render(sheetWith("full"));
      const field = screen.getByRole("textbox", { name: "Field" });
      field.focus();

      rerender(sheetWith("peek"));

      expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
      expect(scrollIntoView.mock.contexts[0]).toBe(field);
    });

    it("leaves the scroll alone when focus is on the handle, which is always in view", async () => {
      const user = userEvent.setup();
      renderWithField("half");
      handle().focus();

      await user.keyboard("{End}");

      expect(screen.getByRole("status")).toHaveTextContent(t("status.sheet.full"));
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it("leaves the scroll alone while the snap stays where it is", async () => {
      const user = userEvent.setup();
      renderWithField("half");
      screen.getByRole("textbox", { name: "Field" }).focus();

      await user.keyboard("typing");

      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });

  describe("live region", () => {
    it("is silent until the snap changes", () => {
      renderSheet();

      expect(screen.getByRole("status")).toHaveTextContent("");
    });

    it.each<[string, SheetSnap, string]>([
      ["{Home}", "peek", t("status.sheet.peek")],
      ["{ArrowDown}", "peek", t("status.sheet.peek")],
      ["{End}", "full", t("status.sheet.full")],
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

      expect(screen.getByRole("status")).toHaveTextContent(t("status.sheet.half"));
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

      expect(screen.getByRole("status")).toHaveTextContent(t("status.sheet.full"));
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
      installFakeTimers();
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
      pointerClick();

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
      pointerClick();

      expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("full");
    });

    it("treats a press and release without movement as a tap", () => {
      const onSnapChange = vi.fn();
      renderSheet({ defaultSnap: "peek", onSnapChange });

      down(500);
      up(500);
      pointerClick();

      expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("half");
      expect(handle()).not.toHaveAttribute("data-dragging");
    });

    // R3-15: a press is a tap while it stays inside TAP_SLOP of where it came down, however it
    // got there. useMove reports any move at all (even one pixel of jitter) and ends the move on
    // pointercancel too, so the sheet counts the travel itself.
    it.each<[string, readonly Step[]]>([
      ["a pixel", [[0, -1]]],
      ["four pixels", [[0, -4]]],
      ["as far as the slop", [[0, -TAP_SLOP]]],
      ["a pixel at a time, as far as the slop", creep(TAP_SLOP)],
      ["a diagonal inside the slop", [[INSIDE_DIAGONAL, -INSIDE_DIAGONAL]]],
    ])("treats a press that wandered %s as a tap", (_name, steps) => {
      const onSnapChange = vi.fn();
      renderSheet({ defaultSnap: "peek", onSnapChange });
      sheet();

      press(steps);
      pointerClick();

      expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("half");
    });

    it.each<[string, readonly Step[]]>([
      ["just past the slop upwards", [[0, -(TAP_SLOP + 1)]]],
      ["just past the slop downwards", [[0, TAP_SLOP + 1]]],
      ["just past the slop sideways", [[TAP_SLOP + 1, 0]]],
      ["a diagonal past the slop", [[PAST_DIAGONAL, -PAST_DIAGONAL]]],
      ["a pixel at a time, just past the slop", creep(TAP_SLOP + 1)],
      [
        "out past the slop and back to where it came down",
        [
          [0, -50],
          [0, 50],
        ],
      ],
    ])("turns a press that wandered %s into a drag, whose click is not a tap", (_name, steps) => {
      const onSnapChange = vi.fn();
      renderSheet({ defaultSnap: "peek", onSnapChange });
      sheet();

      press(steps);
      pointerClick();

      expect(onSnapChange).not.toHaveBeenCalled();
    });

    it("forgets how far the last press went when the next one comes down", () => {
      const onSnapChange = vi.fn();
      renderSheet({ onSnapChange });
      sheet();
      // The pointer comes up away from the handle, so no click follows and no press is left open.
      press([[0, -50]], upAway);
      onSnapChange.mockClear();

      press([[0, -1]]);
      pointerClick();

      expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("full");
    });

    it("does not count the arrow keys as travel of the next press", () => {
      const onSnapChange = vi.fn();
      renderSheet({ defaultSnap: "peek", onSnapChange });
      sheet();
      for (let key = 0; key <= TAP_SLOP; key += 1) {
        fireEvent.keyDown(handle(), { key: "ArrowUp" });
      }
      onSnapChange.mockClear();

      press([[0, -1]]);
      pointerClick();

      expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("half");
    });

    it("still flings from a quick flick inside the slop, and its click is not a second tap", () => {
      const onSnapChange = vi.fn();
      renderSheet({ onSnapChange });
      sheet();

      down(500);
      move(499);
      wait(4);
      move(500 - TAP_SLOP);
      up(500 - TAP_SLOP);
      pointerClick();

      expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("full");
    });

    it("leaves nothing behind when the browser cancels the pointer in the middle of a tap", () => {
      const onSnapChange = vi.fn();
      renderSheet({ defaultSnap: "peek", onSnapChange });
      sheet();

      press([[0, -1]], cancel);
      // No click follows a cancelled pointer. The next press, with the click that ends it, is a tap.
      down(500);
      up(500);
      pointerClick();

      expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("half");
    });

    // A drag whose click never reaches the handle (the button came up away from it, or the browser
    // cancelled the pointer) must not swallow what comes after it. Enter and Space send a click
    // with no pointer behind it.
    describe.each<[string, (y: number, x?: number) => boolean]>([
      ["the button comes up away from the handle", upAway],
      ["the browser cancels the pointer", cancel],
    ])("after a drag in which %s", (_ending, end) => {
      it.each([
        ["Enter", "{Enter}"],
        ["Space", " "],
      ])("lets %s cycle the snap", async (_key, keys) => {
        const user = fakeTimerUser();
        const onSnapChange = vi.fn();
        renderSheet({ onSnapChange });
        sheet();
        press([[0, -50]], end);
        onSnapChange.mockClear();

        await user.tab();
        await user.keyboard(keys);

        expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("full");
      });
    });

    it("does not swallow a click that no pointer made, as `click()` and most screen readers send", () => {
      const onSnapChange = vi.fn();
      renderSheet({ onSnapChange });
      sheet();
      // The pointer comes up away from the handle, so no click follows it: the flag is left armed.
      press([[0, -50]], upAway);
      onSnapChange.mockClear();

      virtualClick();

      expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("full");
    });

    // BS-F1. React Aria's useMove cancels the handle's pointerdown. After a cancelled pointerdown
    // WebKit sends a touch tap pointerup and touchend and no click at all (probe run 40086851607:
    // the iPhone 14 project, and desktop Safari with a touch screen), while Chromium and Firefox
    // still send one. The tap has to cycle the sheet once whichever it is, so it comes from the
    // press, and the click that may follow the press is only the end of that press.
    describe("a tap, with the events that each engine sends for it", () => {
      const ANDROID =
        "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36";

      it("cycles the sheet once when no click follows the pointer, as in WebKit's touch tap", () => {
        const onSnapChange = vi.fn();
        renderSheet({ defaultSnap: "peek", onSnapChange });
        sheet();

        down(500);
        up(500);
        wait(ANY_CLICK_IS_IN);

        expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("half");
      });

      it("cycles the sheet once when a click follows the pointer, as in Chromium's touch tap", () => {
        const onSnapChange = vi.fn();
        renderSheet({ defaultSnap: "peek", onSnapChange });
        sheet();

        down(500);
        up(500);
        clickOf({ detail: 1, pointerType: "touch" });
        wait(ANY_CLICK_IS_IN);

        expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("half");
      });

      it("cycles the sheet once for a mouse click", () => {
        const onSnapChange = vi.fn();
        renderSheet({ defaultSnap: "peek", onSnapChange });
        sheet();
        const mouse = { pointerId: 1, pointerType: "mouse", button: 0 } as const;

        fireEvent.pointerDown(handle(), mouse);
        fireEvent.pointerUp(handle(), mouse);
        clickOf({ detail: 1, pointerType: "mouse" });
        wait(ANY_CLICK_IS_IN);

        expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("half");
      });

      it.each<[string, () => void]>([
        ["without", () => undefined],
        ["with", () => clickOf({ detail: 1, pointerType: "touch" })],
      ])(
        "does not cycle the sheet at the end of a real drag that ends on the handle, %s the click after it",
        (_name, afterTheDrag) => {
          const onSnapChange = vi.fn();
          renderSheet({ onSnapChange });
          sheet();

          press([[0, -50]]);
          afterTheDrag();
          wait(ANY_CLICK_IS_IN);

          expect(onSnapChange).not.toHaveBeenCalled();
        },
      );

      // React Aria's isVirtualClick reads Android TalkBack's activation as virtual although it
      // carries a pointerType and a detail above 0: a click with pointer data and buttons 1.
      it("cycles the sheet once for a virtual click with pointer data, right after a drag", () => {
        vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(ANDROID);
        const onSnapChange = vi.fn();
        renderSheet({ onSnapChange });
        sheet();
        press([[0, -50]], upAway);
        onSnapChange.mockClear();

        clickOf({ detail: 1, pointerType: "touch", buttons: 1 });
        wait(ANY_CLICK_IS_IN);

        expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("full");
      });
    });

    // D-60: a pointer tap on the handle, touch, mouse or pen, moves no focus, and a drag moves none
    // either. In WebKit a touch tap sends no click after the cancelled pointerdown, React Aria's
    // press waits 80 ms and then focuses its target and clicks it, so the press is made on a
    // surface that cannot take the focus: the button inside it is the one stop of the Tab order.
    describe("focus, when a pointer presses the handle (D-60)", () => {
      beforeEach(() => {
        // Testing Library only advances its own timers when it sees a `jest` global, and without
        // that user-event waits forever on Vitest's fake timers.
        vi.stubGlobal("jest", { advanceTimersByTime: vi.advanceTimersByTime.bind(vi) });
      });

      /** The focus events of the page since `listen`, as the window hears them first (capture). */
      const heard: string[] = [];
      const stops: (() => void)[] = [];
      function listen(): void {
        heard.length = 0;
        for (const type of ["focusin", "focusout", "focus", "blur"]) {
          const record = (event: Event): void => {
            if (event.target instanceof Element) {
              heard.push(`${type} ${event.target.getAttribute("aria-label") ?? "element"}`);
            }
          };
          window.addEventListener(type, record, true);
          stops.push(() => {
            window.removeEventListener(type, record, true);
          });
        }
      }
      afterEach(() => {
        for (const stop of stops.splice(0)) stop();
      });

      /** A sheet that holds a text field with the focus, and listens from then on. */
      function renderWithField(
        props: { defaultSnap?: SheetSnap; onSnapChange?: (snap: SheetSnap) => void } = {},
      ): HTMLElement {
        render(
          <BottomSheet label={LABEL} {...props}>
            <input aria-label="Field" />
          </BottomSheet>,
        );
        sheet();
        const field = screen.getByRole("textbox", { name: "Field" });
        field.focus();
        listen();
        return field;
      }

      it("keeps the focus on the control that had it when no click follows a tap, as in WebKit", () => {
        const onSnapChange = vi.fn();
        const field = renderWithField({ defaultSnap: "peek", onSnapChange });

        down(500);
        up(500);
        wait(ANY_CLICK_IS_IN);

        expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("half");
        expect(field).toHaveFocus();
        expect(heard).toEqual([]);
      });

      it("keeps the focus on the control that had it when a click follows a tap, as in Chromium", () => {
        const onSnapChange = vi.fn();
        const field = renderWithField({ defaultSnap: "peek", onSnapChange });

        down(500);
        up(500);
        clickOf({ detail: 1, pointerType: "touch" });
        wait(ANY_CLICK_IS_IN);

        expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("half");
        expect(field).toHaveFocus();
        expect(heard).toEqual([]);
      });

      it("leaves the page body with the focus, and the handle with none, when nothing had it", () => {
        const onSnapChange = vi.fn();
        renderSheet({ defaultSnap: "peek", onSnapChange });
        sheet();
        listen();

        down(500);
        up(500);
        wait(ANY_CLICK_IS_IN);

        expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("half");
        expect(document.body).toHaveFocus();
        expect(heard).toEqual([]);
      });

      it.each<[string, (y: number, x?: number) => boolean]>([
        ["on the handle", up],
        ["away from the handle", upAway],
      ])("keeps the focus on the control that had it after a drag that ends %s", (_end, end) => {
        const onSnapChange = vi.fn();
        const field = renderWithField({ onSnapChange });

        press([[0, -50]], end);
        wait(ANY_CLICK_IS_IN);

        expect(onSnapChange).not.toHaveBeenCalledWith("half");
        expect(field).toHaveFocus();
        expect(heard).toEqual([]);
      });

      it.each([
        ["Enter", "{Enter}"],
        ["Space", " "],
      ])("lets %s cycle the sheet with the focus staying on the handle", async (_key, keys) => {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const onSnapChange = vi.fn();
        renderWithField({ onSnapChange });
        await user.tab({ shift: true });
        expect(handle()).toHaveFocus();
        listen();

        await user.keyboard(keys);

        expect(onSnapChange).toHaveBeenCalledExactlyOnceWith("full");
        expect(handle()).toHaveFocus();
        expect(heard).toEqual([]);
      });
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

    // D-60: the press surface only carries the press and the move. As a box of its own it would
    // stop the handle from being a flex item of the sheet, and the layout would move.
    it("keeps the press surface out of the layout, so the handle stays a flex item of the sheet", () => {
      expect(css).toMatch(/\.pressSurface \{[^}]*display:\s*contents;/u);
    });

    // WCAG technique C43: the content scrolls under the part of the sheet below the screen edge, so
    // a focused control is revealed above that edge, and clear of it by one `--space-2`.
    it("keeps a focused control clear of the screen edge with the content's scroll padding", () => {
      expect(css).toMatch(
        /\.content \{[^}]*scroll-padding-block-end:\s*calc\(\s*var\(--sheet-offset\)\s*\+\s*env\(safe-area-inset-bottom, 0px\)\s*\+\s*var\(--space-2\)\s*\);/u,
      );
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

    it("has no violations in the demo, with the sheet hidden or shown", async () => {
      const user = userEvent.setup();
      const { container } = render(<>{demo.states[0]?.node}</>);
      await expectNoAxeViolations(container);

      await user.click(screen.getByRole("button", { name: SHOW }));

      await expectNoAxeViolations(container);
    });
  });

  describe("demo", () => {
    it("shows the snap the sheet is at and follows it", async () => {
      const user = userEvent.setup();
      render(<>{demo.states[0]?.node}</>);
      await user.click(screen.getByRole("button", { name: SHOW }));
      screen.getByRole("button", { name: t("sheet.handle.label") }).focus();

      await user.keyboard("{End}");

      expect(screen.getByText(/Snap: full/)).toBeInTheDocument();
    });

    it("keeps the viewport-fixed sheet out of the page until it is asked for", async () => {
      const user = userEvent.setup();
      render(<>{demo.states[0]?.node}</>);
      expect(screen.queryByRole("region", { name: LABEL })).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: SHOW }));
      expect(screen.getByRole("region", { name: LABEL })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: HIDE }));
      expect(screen.queryByRole("region", { name: LABEL })).not.toBeInTheDocument();
    });

    it("can be driven from outside through its snap buttons", async () => {
      const user = userEvent.setup();
      render(<>{demo.states[0]?.node}</>);

      await user.click(screen.getByRole("button", { name: "Peek" }));
      expect(screen.getByText(/Snap: peek/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Half" }));
      expect(screen.getByText(/Snap: half/)).toBeInTheDocument();
    });
  });
});
