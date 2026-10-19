import { RISK_LEVELS, type RiskLevel } from "./riskLevels";

/** Miles per risk level; every level is present, zero means "none on this route". */
export type MilesByLevel = Readonly<Record<RiskLevel, number>>;

/** Horizontal placement of one drawn segment, in the same unit as the bar width. */
export interface BarSegment {
  readonly level: RiskLevel;
  readonly miles: number;
  readonly x: number;
  readonly width: number;
}

/**
 * Places the segments of a stacked bar. Zero-mile levels are omitted, the rest keep Low to Unknown
 * order, are separated by `gap`, share the remaining width in proportion to their miles, and are
 * never narrower than `minWidth` (the width they lack is taken proportionally from the others).
 * With no miles at all there is nothing to draw and the result is empty.
 */
export function layoutSegments(
  miles: MilesByLevel,
  totalWidth: number,
  gap: number,
  minWidth: number,
): readonly BarSegment[] {
  const rows = RISK_LEVELS.map((level) => ({
    level,
    miles: miles[level],
    width: 0,
    pinned: false,
  })).filter((row) => row.miles > 0);
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
