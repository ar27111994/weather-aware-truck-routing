import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { mergeProps, useFocusRing, useHover, useMove, usePress, type PressEvent } from "react-aria";

import { cx } from "../../foundation/cx";
import { t } from "../../foundation/strings";
import { VisuallyHidden } from "../VisuallyHidden";
import styles from "./BottomSheet.module.css";
import {
  beginDrag,
  cycleSnap,
  directionBetween,
  dragBy,
  dragShift,
  releaseSnap,
  resolveSnapHeights,
  stepSnap,
  type DragSession,
  type SheetDirection,
  type SheetSnap,
  type SnapHeights,
} from "./sheetGeometry";

export type { SheetSnap } from "./sheetGeometry";

/** Props for {@link BottomSheet}. */
export interface BottomSheetProps {
  /** What the sheet holds. It scrolls inside the sheet at every snap point. */
  readonly children: ReactNode;
  /** Accessible name of the region (the demo passes `t("app.regions.planner")`). */
  readonly label: string;
  /** The snap point, when the parent owns it. Pair with `onSnapChange`. */
  readonly snap?: SheetSnap;
  /** The snap point to start at when the sheet owns it. Defaults to `half`. */
  readonly defaultSnap?: SheetSnap;
  /** Called with the snap point the user asked for (drag release, tap, keyboard). */
  readonly onSnapChange?: (snap: SheetSnap) => void;
  /** The timeline dock: it sits on the top edge of the sheet, moves with it and hides at `full`. */
  readonly dock?: ReactNode;
  /**
   * From 1024 px, draw the sheet as the page's side panel instead of a sheet over the map (the
   * planner, DESIGN.md section 7). It is the same element on every screen, so nothing is rebuilt
   * when the screen is resized or when the prerendered page is hydrated.
   */
  readonly panelOnWide?: boolean;
}

/** Heights before the first pointer press has measured the sheet; a drag always measures first. */
const UNMEASURED: SnapHeights = { peek: 0, half: 0, full: 0 };

/**
 * How far (px) a press may wander from where it came down and still be a tap. Past it the press is
 * a drag, and the click that follows its release is not a tap. 8 px is Android's touch slop
 * (`ViewConfiguration.TOUCH_SLOP`, the distance a touch can wander before the system thinks the
 * user is scrolling) and GTK's drag threshold. A finger on the handle shifts a few px between
 * pointer events, so 0 or 1 px would turn a tap into a drag; much more than 8 px would turn a short
 * drag into a tap, and the click would cycle the snap that the drag has just settled.
 */
export const TAP_SLOP = 8;

/**
 * Reads the snap heights from the laid-out sheet. The sheet box is as tall as its full snap and its
 * `min-height` is the resolved peek height (token plus safe-area inset), so layout stays in CSS.
 */
function measureSheet(sheet: HTMLElement): SnapHeights {
  const viewportHeight = window.innerHeight;
  const peekHeight = parseFloat(getComputedStyle(sheet).minHeight);
  const headerGap = viewportHeight - sheet.getBoundingClientRect().height;
  return resolveSnapHeights(viewportHeight, peekHeight, headerGap);
}

/**
 * Mobile bottom sheet over the map, with three snap points (peek, half, full). It is a region, not
 * a modal dialog: the map behind it stays interactive. The handle drags (release settles on the
 * nearest snap point, a fast flick goes to the next one), taps to cycle peek, half, full, half,
 * peek (a press that stays within {@link TAP_SLOP} of where it came down is a tap), and takes
 * ArrowUp / ArrowDown to step, Home / End to jump and Enter / Space to cycle. The
 * snap is animated with the sheet motion tokens, which are 0 under reduced motion. Every snap
 * change is announced through a polite live region. A pointer tap or drag on the handle moves
 * no focus, in every engine (D-60): the control that had it keeps it.
 */
export function BottomSheet({
  children,
  label,
  snap: controlledSnap,
  defaultSnap = "half",
  onSnapChange,
  dock,
  panelOnWide = false,
}: BottomSheetProps): ReactElement {
  const [uncontrolledSnap, setUncontrolledSnap] = useState<SheetSnap>(defaultSnap);
  const snap = controlledSnap ?? uncontrolledSnap;

  // Direction of the last move and the announcement follow the snap however it changed (a drag,
  // the keyboard, or a parent that owns it): adjusted during render, not in an effect.
  const [previousSnap, setPreviousSnap] = useState<SheetSnap>(snap);
  const [direction, setDirection] = useState<SheetDirection>("up");
  const [announced, setAnnounced] = useState<SheetSnap | null>(null);
  if (previousSnap !== snap) {
    setPreviousSnap(snap);
    setDirection(directionBetween(previousSnap, snap));
    setAnnounced(snap);
  }

  const [shift, setShift] = useState<number | null>(null);
  const heights = useRef<SnapHeights>(UNMEASURED);
  const session = useRef<DragSession | null>(null);
  const clickIsDragEnd = useRef(false);
  // Where the press on the handle has got to since it came down, and whether it ever left TAP_SLOP.
  const press = useRef({ x: 0, y: 0, isDrag: false });

  const commit = (next: SheetSnap): void => {
    if (next === snap) {
      return;
    }
    if (controlledSnap === undefined) {
      setUncontrolledSnap(next);
    }
    onSnapChange?.(next);
  };

  const { moveProps } = useMove({
    onMove: (event) => {
      if (event.pointerType === "keyboard") {
        // useMove reports the arrow keys as one-unit moves: ArrowUp is negative on y.
        if (event.deltaY < 0) {
          commit(stepSnap(snap, "up"));
        } else if (event.deltaY > 0) {
          commit(stepSnap(snap, "down"));
        }
        return;
      }
      press.current.x += event.deltaX;
      press.current.y += event.deltaY;
      if (Math.hypot(press.current.x, press.current.y) > TAP_SLOP) {
        press.current.isDrag = true;
      }
      session.current = dragBy(
        session.current ?? beginDrag(snap, heights.current),
        event.deltaY,
        performance.now(),
      );
      setShift(dragShift(session.current));
    },
    onMoveEnd: (event) => {
      if (event.pointerType === "keyboard") {
        return;
      }
      const next = releaseSnap(session.current, performance.now(), snap);
      session.current = null;
      // The press that ends here still ends in a click, which the browser sends after a drag that
      // ends on the handle, or which React Aria makes where the browser sends none. It is not a
      // tap. A press stays a tap when it never left TAP_SLOP and its release left the sheet where
      // it was (a quick flick inside the slop still flings, and its click must not cycle the sheet
      // again). A cancelled pointer ends here too, as useMove cannot tell, and sends no click, so
      // the flag can outlive its drag: a press that no pointer made ignores it, and the next
      // pointer press clears it.
      clickIsDragEnd.current = press.current.isDrag || next !== snap;
      press.current = { x: 0, y: 0, isDrag: false };
      setShift(null);
      commit(next);
    },
  });
  const { focusProps, isFocusVisible } = useFocusRing();
  const { hoverProps, isHovered } = useHover({});

  const nextSnap = cycleSnap(snap, direction);

  // The tap, Enter, Space and a screen reader's activation all end here, as the press that React
  // Aria's `usePress` makes of them (BS-F1). Its press is the tap, so it does not depend on the
  // click that WebKit leaves out after a cancelled pointerdown: `usePress` ends a pointer press in
  // the browser's click, or makes the click itself when none comes. A press that a pointer made
  // (mouse, touch, pen) meets the flag of a drag: the click after a drag is not a tap. A keyboard
  // or virtual press never does. `isVirtualClick` says what is virtual, including the activations
  // that carry pointer data and a detail above 0 (Firefox with JAWS or NVDA, Android TalkBack), and
  // the flag may have outlived a drag whose click never came.
  const handlePress = (event: PressEvent): void => {
    const byPointer = event.pointerType !== "keyboard" && event.pointerType !== "virtual";
    const endsDrag = byPointer && clickIsDragEnd.current;
    clickIsDragEnd.current = false;
    if (!endsDrag) {
      commit(nextSnap);
    }
  };
  // `useMove` takes the pointer's moves, and the press takes what is left: a tap, and the keys.
  // D-60 (DESIGN.md, BottomSheet): a pointer tap moves no focus, in every engine.
  // `preventFocusOnPress` covers the engines that send a mousedown. It does not cover the tap
  // where the engine sends no click (WebKit's touch tap after the cancelled pointerdown): then
  // `usePress` waits 80 ms, focuses its target and clicks it, and that wait does not read
  // `preventFocusOnPress` (probe run 40130651455: a focus() call from a timer on the handle, the
  // blur of the field that had focus, then a click with detail 0). The target of a press is the
  // element that carries its props, so they are on the press surface, which cannot take focus:
  // its focus() does nothing, its click() is the tap, and the button inside it, the one stop of
  // the Tab order, gets focus from the keyboard only.
  const { pressProps } = usePress({ onPress: handlePress, preventFocusOnPress: true });

  // `data-pressed` while the primary pointer button is down on the handle. The press of `usePress`
  // ends when the pointer leaves the handle, and a drag leaves it with the button still down, so
  // the pressed look is tracked here. The release is heard on the window: a drag leaves the handle
  // before the button comes up.
  const [isPressed, setPressed] = useState(false);
  useEffect(() => {
    if (!isPressed) {
      return;
    }
    const release = (): void => {
      setPressed(false);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [isPressed]);

  // The content scrolls under the part of the sheet below the screen edge. Its scroll padding
  // reveals a control when focus moves to it; after the snap changes under a resting focus (a tap
  // on the handle moves no focus), the focused control is scrolled into the visible part (DR1).
  const contentId = useId();
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focused = document.activeElement;
    if (content.current?.contains(focused)) {
      focused?.scrollIntoView({ block: "nearest" });
    }
  }, [snap]);

  const surfaceProps = mergeProps(moveProps, pressProps);
  const handleProps = mergeProps(focusProps, hoverProps, {
    onPointerDown: (event: PointerEvent<HTMLButtonElement>): void => {
      if (event.button === 0) {
        setPressed(true);
      }
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>): void => {
      if (event.key === "Home") {
        event.preventDefault();
        commit("peek");
      } else if (event.key === "End") {
        event.preventDefault();
        commit("full");
      }
    },
  });

  return (
    <section
      aria-label={label}
      className={cx(styles.sheet)}
      data-snap={snap}
      data-wide={panelOnWide ? "panel" : undefined}
      data-dragging={shift === null ? undefined : "true"}
      style={
        shift === null
          ? undefined
          : { transform: `translateY(calc(var(--sheet-offset) + ${String(shift)}px))` }
      }
      onPointerDownCapture={(event) => {
        // Measured on every press, so a rotation or a collapsing browser bar never leaves it stale.
        clickIsDragEnd.current = false;
        heights.current = measureSheet(event.currentTarget);
      }}
    >
      {dock === undefined ? null : (
        <div className={cx(styles.dock)} hidden={snap === "full"}>
          {dock}
        </div>
      )}
      <div {...surfaceProps} className={cx(styles.pressSurface)}>
        <button
          {...handleProps}
          type="button"
          className={cx(styles.handle)}
          aria-label={t("sheet.handle.label")}
          aria-controls={contentId}
          aria-expanded={snap !== "peek"}
          data-hovered={isHovered ? "true" : undefined}
          data-pressed={isPressed ? "true" : undefined}
          data-focus-visible={isFocusVisible ? "true" : undefined}
        >
          <span className={cx(styles.grip)} aria-hidden="true" />
        </button>
      </div>
      <div id={contentId} ref={content} className={cx(styles.content)}>
        {children}
      </div>
      <div role="status" aria-live="polite">
        <VisuallyHidden>
          {announced === null ? null : t(`status.sheet.${announced}`)}
        </VisuallyHidden>
      </div>
    </section>
  );
}
