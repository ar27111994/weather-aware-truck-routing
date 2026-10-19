import { useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { VisuallyHidden, mergeProps, useFocusRing, useMove } from "react-aria";

import { cls } from "../../cls";
import { copy } from "../../copy";
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
  /** Accessible name of the region (the demo passes `copy.app.regions.planner`). */
  readonly label: string;
  /** The snap point, when the parent owns it. Pair with `onSnapChange`. */
  readonly snap?: SheetSnap;
  /** The snap point to start at when the sheet owns it. Defaults to `half`. */
  readonly defaultSnap?: SheetSnap;
  /** Called with the snap point the user asked for (drag release, tap, keyboard). */
  readonly onSnapChange?: (snap: SheetSnap) => void;
  /** The timeline dock: it sits on the top edge of the sheet, moves with it and hides at `full`. */
  readonly dock?: ReactNode;
}

/** Heights before the first pointer press has measured the sheet; a drag always measures first. */
const UNMEASURED: SnapHeights = { peek: 0, half: 0, full: 0 };

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
 * peek, and takes ArrowUp / ArrowDown to step, Home / End to jump and Enter / Space to cycle. The
 * snap is animated with the sheet motion tokens, which are 0 under reduced motion. Every snap
 * change is announced through a polite live region.
 */
export function BottomSheet({
  children,
  label,
  snap: controlledSnap,
  defaultSnap = "half",
  onSnapChange,
  dock,
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
      // The browser still sends a click after a drag that ends on the handle; it is not a tap.
      clickIsDragEnd.current = true;
      setShift(null);
      commit(next);
    },
  });
  const { focusProps, isFocusVisible } = useFocusRing();

  const nextSnap = cycleSnap(snap, direction);
  const expands = directionBetween(snap, nextSnap) === "up";

  const handleClick = (): void => {
    if (clickIsDragEnd.current) {
      clickIsDragEnd.current = false;
      return;
    }
    commit(nextSnap);
  };

  const handleProps = mergeProps(moveProps, focusProps, {
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
      className={cls(styles["sheet"])}
      data-snap={snap}
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
        <div className={cls(styles["dock"])} hidden={snap === "full"}>
          {dock}
        </div>
      )}
      <button
        {...handleProps}
        onClick={handleClick}
        type="button"
        className={cls(styles["handle"])}
        aria-label={expands ? copy.sheet.handle.expand : copy.sheet.handle.collapse}
        aria-expanded={snap !== "peek"}
        data-focus-visible={isFocusVisible ? "true" : undefined}
      >
        <span className={cls(styles["grip"])} aria-hidden="true" />
      </button>
      <div className={cls(styles["content"])}>{children}</div>
      <VisuallyHidden elementType="div" role="status" aria-live="polite">
        {announced === null ? null : copy.status.sheet[announced]}
      </VisuallyHidden>
    </section>
  );
}
