/**
 * Pure geometry of the bottom sheet: where the three snap points sit, which one a release lands
 * on, and how the handle steps and cycles. No DOM and no React: the component only measures and
 * feeds numbers in. All heights are the sheet's visible height in px, so a taller sheet is a
 * bigger number and a finger moving up is a negative `deltaY`.
 */

/** The three resting positions of the sheet. */
export type SheetSnap = "peek" | "half" | "full";

/** Which way the sheet last moved: `up` expands it, `down` collapses it. */
export type SheetDirection = "up" | "down";

/** Visible height of the sheet at each snap point, in px. */
export interface SnapHeights {
  readonly peek: number;
  readonly half: number;
  readonly full: number;
}

/** A finger position sample: when it happened and how far the finger had travelled by then. */
export interface PointerSample {
  /** Milliseconds, from any monotonic clock. */
  readonly time: number;
  /** Finger travel since the drag began, in px; positive is down. */
  readonly travel: number;
}

/** A drag in progress. Immutable: every step returns a new session. */
export interface DragSession {
  readonly heights: SnapHeights;
  /** Visible height the sheet had when the finger went down. */
  readonly startHeight: number;
  /** Finger travel since then, unclamped, in px; positive is down. */
  readonly travel: number;
  readonly samples: readonly PointerSample[];
}

/** Release speed (px per ms) above which a drag flings to the next snap point (DESIGN.md 10). */
export const FLING_VELOCITY = 0.5;

/** Only finger samples this recent (ms) count towards the release velocity. */
export const VELOCITY_WINDOW = 100;

/** A height within this many px of a snap point counts as sitting on it. */
const ON_SNAP_TOLERANCE = 1;

/**
 * Resolves the visible height at each snap point. Peek is the measured peek height (the token plus
 * the safe-area inset), half is half the viewport, full is the viewport minus the header gap. The
 * heights never invert on a very short viewport (400% zoom): half and full are held at or above
 * peek, and half at or below full.
 *
 * @param viewportHeight - Height of the viewport in px (`100dvh`).
 * @param peekHeight - Resolved peek height in px.
 * @param headerGap - Space kept free above the full sheet in px (the header height).
 */
export function resolveSnapHeights(
  viewportHeight: number,
  peekHeight: number,
  headerGap: number,
): SnapHeights {
  const full = Math.max(viewportHeight - headerGap, peekHeight);
  const half = Math.min(Math.max(viewportHeight / 2, peekHeight), full);
  return { peek: peekHeight, half, full };
}

/** The snap point closest to a visible height. A tie goes to the more collapsed snap. */
export function nearestSnap(height: number, heights: SnapHeights): SheetSnap {
  const toPeek = Math.abs(height - heights.peek);
  const toHalf = Math.abs(height - heights.half);
  const toFull = Math.abs(height - heights.full);
  if (toPeek <= toHalf && toPeek <= toFull) {
    return "peek";
  }
  return toHalf <= toFull ? "half" : "full";
}

/** The first snap point above a visible height (a height on a snap counts as being on it). */
function snapAbove(height: number, heights: SnapHeights): SheetSnap {
  return heights.half > height + ON_SNAP_TOLERANCE ? "half" : "full";
}

/** The first snap point below a visible height (a height on a snap counts as being on it). */
function snapBelow(height: number, heights: SnapHeights): SheetSnap {
  return heights.half < height - ON_SNAP_TOLERANCE ? "half" : "peek";
}

/**
 * Where a released drag settles. Faster than {@link FLING_VELOCITY} flings to the next snap point in
 * the direction of travel; anything slower settles on the nearest snap point.
 *
 * @param height - Visible height at release, in px.
 * @param velocity - Finger velocity at release in px per ms; negative is up.
 */
export function snapForRelease(height: number, velocity: number, heights: SnapHeights): SheetSnap {
  if (velocity < -FLING_VELOCITY) {
    return snapAbove(height, heights);
  }
  if (velocity > FLING_VELOCITY) {
    return snapBelow(height, heights);
  }
  return nearestSnap(height, heights);
}

/** One step from a snap point, stopping at the ends. */
export function stepSnap(snap: SheetSnap, direction: SheetDirection): SheetSnap {
  if (direction === "up") {
    return snap === "peek" ? "half" : "full";
  }
  return snap === "full" ? "half" : "peek";
}

/**
 * The snap a tap on the handle goes to: peek, half, full, half, peek. The ends always turn back to
 * half; half keeps heading the way the sheet last moved.
 */
export function cycleSnap(snap: SheetSnap, direction: SheetDirection): SheetSnap {
  if (snap === "half") {
    return stepSnap("half", direction);
  }
  return "half";
}

const SNAP_RANK: Readonly<Record<SheetSnap, number>> = { peek: 0, half: 1, full: 2 };

/** The direction of a move between two different snap points. */
export function directionBetween(from: SheetSnap, to: SheetSnap): SheetDirection {
  return SNAP_RANK[to] > SNAP_RANK[from] ? "up" : "down";
}

/**
 * Finger velocity at release, in px per ms (negative is up), from the samples inside
 * {@link VELOCITY_WINDOW}. A finger that rested before it lifted has no velocity.
 */
export function releaseVelocity(samples: readonly PointerSample[], releaseTime: number): number {
  const last = samples.at(-1);
  if (last === undefined || releaseTime - last.time > VELOCITY_WINDOW) {
    return 0;
  }
  const first = samples.reduce(
    (earliest, sample) =>
      last.time - sample.time <= VELOCITY_WINDOW && sample.time < earliest.time ? sample : earliest,
    last,
  );
  const elapsed = last.time - first.time;
  return elapsed === 0 ? 0 : (last.travel - first.travel) / elapsed;
}

/** Starts a drag from a snap point. */
export function beginDrag(snap: SheetSnap, heights: SnapHeights): DragSession {
  return { heights, startHeight: heights[snap], travel: 0, samples: [] };
}

/** Adds a finger move of `deltaY` px (positive is down) at `time` ms. */
export function dragBy(session: DragSession, deltaY: number, time: number): DragSession {
  const travel = session.travel + deltaY;
  const recent = session.samples.filter((sample) => time - sample.time <= VELOCITY_WINDOW);
  return { ...session, travel, samples: [...recent, { time, travel }] };
}

/** Visible height the sheet has right now, held between peek and full. */
export function dragHeight(session: DragSession): number {
  const { peek, full } = session.heights;
  return Math.min(Math.max(session.startHeight - session.travel, peek), full);
}

/** How far the sheet sits below its resting position at the start of the drag, in px. */
export function dragShift(session: DragSession): number {
  return session.startHeight - dragHeight(session);
}

/**
 * The snap a drag settles on when the finger lifts at `time` ms. With no drag in progress the
 * sheet stays on `current`.
 */
export function releaseSnap(
  session: DragSession | null,
  time: number,
  current: SheetSnap,
): SheetSnap {
  if (session === null) {
    return current;
  }
  return snapForRelease(
    dragHeight(session),
    releaseVelocity(session.samples, time),
    session.heights,
  );
}
