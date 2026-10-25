import { RISK_LEVELS, type RiskKey } from "../../foundation/risk";

/** Draw order: the five scored levels from Low to No Travel, then Unknown. */
const BAR_ORDER: readonly RiskKey[] = [...RISK_LEVELS, "unknown"];

/** Miles per risk level; every level is present, zero means "none on this route". */
export type MilesByLevel = Readonly<Record<RiskKey, number>>;

/** Horizontal placement of one drawn segment, in the same unit as the bar width. */
export interface BarSegment {
  readonly level: RiskKey;
  readonly miles: number;
  readonly x: number;
  readonly width: number;
}

/**
 * Places the segments of a stacked bar. Levels without miles (zero, negative or not finite) are
 * omitted, the rest keep Low to Unknown order, are separated by `gap`, share the remaining width in
 * proportion to their miles, and are never narrower than `minWidth` (the width they lack is taken
 * proportionally from the others). With no miles at all there is nothing to draw and the result is
 * empty.
 */
export function layoutSegments(
  miles: MilesByLevel,
  totalWidth: number,
  gap: number,
  minWidth: number,
): readonly BarSegment[] {
  const rows = BAR_ORDER.map((level) => ({
    level,
    miles: miles[level],
    width: 0,
    pinned: false,
  })).filter((row) => Number.isFinite(row.miles) && row.miles > 0);
  const available = totalWidth - gap * Math.max(rows.length - 1, 0);

  // Pinning a segment at the minimum shrinks the others, which can push another one under it.
  let settled = false;
  while (!settled) {
    const pinnedCount = rows.filter((row) => row.pinned).length;
    const freeMiles = rows.reduce((sum, row) => (row.pinned ? sum : sum + row.miles), 0);
    const freeWidth = available - minWidth * pinnedCount;
    rows.forEach((row) => {
      row.width = row.pinned ? minWidth : (row.miles / freeMiles) * freeWidth;
    });
    const tooNarrow = rows.filter((row) => !row.pinned && row.width < minWidth);
    tooNarrow.forEach((row) => {
      row.pinned = true;
    });
    settled = tooNarrow.length === 0;
  }

  let x = 0;
  return rows.map((row) => {
    const segment = { level: row.level, miles: row.miles, x, width: row.width };
    x += row.width + gap;
    return segment;
  });
}
