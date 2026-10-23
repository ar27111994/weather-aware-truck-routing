import { RISK_LEVELS, type NullableRiskLevel, type Route } from "../../api/contract";

/** One row of the chart: a level (or Unknown) and where its band sits. */
export interface ProfileRow {
  readonly level: NullableRiskLevel;
  /** Vertical centre of the band, in chart units. */
  readonly y: number;
}

/** One checkpoint as a point on the chart. */
export interface ProfilePoint {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly level: NullableRiskLevel;
}

/** Everything the SVG draws, in chart units (the view box). */
export interface ProfileLayout {
  readonly width: number;
  readonly height: number;
  /** Left edge of the plot, after the level words. */
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly rowHeight: number;
  /** Rows from the top (No Travel) down to Unknown. */
  readonly rows: readonly ProfileRow[];
  readonly points: readonly ProfilePoint[];
  /** Distances (miles) of the axis ticks. */
  readonly ticks: readonly { readonly miles: number; readonly x: number }[];
  /** The step line: each level is held until the next checkpoint. */
  readonly path: string;
}

/** Chart size in view-box units; the SVG scales to its container (DESIGN.md section 10: 200 px high). */
export const PROFILE_SIZE = { width: 340, height: 200 } as const;

const MARGIN = { left: 76, right: 12, top: 8, bottom: 36 } as const;

/** Rows from top to bottom: the worst level first, Unknown last (below Low). */
const ROW_ORDER: readonly NullableRiskLevel[] = [...RISK_LEVELS].reverse();

/** Axis tick spacings in miles for routes over 400 miles, finest first. */
const LONG_ROUTE_SPACINGS_MI = [100, 200, 250, 500, 1_000] as const;

/** One digit of a 12 px axis label is about 7.2 view-box units wide (0.6 em), and a label gets this much air. */
const DIGIT_WIDTH = 7.2;
const LABEL_AIR = 6;

/**
 * Axis tick spacing in miles: 50 for routes up to 400 miles (DESIGN.md section 10), then the
 * smallest of 100, 200, 250, 500 and 1,000 that leaves the widest label its room. DESIGN.md says 100
 * for long routes, which is right while the labels have 3 digits; from 1,000 miles they have 4, and
 * labels every 100 miles overlap (R4-12). The API plans routes up to 3,000 miles.
 */
export function tickSpacing(totalMiles: number): number {
  if (totalMiles <= 400) return 50;
  const room = PROFILE_SIZE.width - MARGIN.left - MARGIN.right;
  const label = String(Math.floor(totalMiles)).length * DIGIT_WIDTH + LABEL_AIR;
  return (
    LONG_ROUTE_SPACINGS_MI.find((spacing) => (room * spacing) / totalMiles >= label) ??
    LONG_ROUTE_SPACINGS_MI[LONG_ROUTE_SPACINGS_MI.length - 1]
  );
}

/**
 * Lays a route's checkpoints out as a risk profile: distance along x, level band along y, Unknown in
 * its own row beneath Low. The x scale runs from the origin to the route's length; a route of zero
 * length puts everything at the start.
 */
export function layoutProfile(route: Route): ProfileLayout {
  const { width, height } = PROFILE_SIZE;
  const left = MARGIN.left;
  const right = width - MARGIN.right;
  const top = MARGIN.top;
  const bottom = height - MARGIN.bottom;
  const rows = [...ROW_ORDER, null];
  const rowHeight = (bottom - top) / rows.length;
  const total = route.distance_mi;
  const xOf = (miles: number): number => left + (total > 0 ? (miles / total) * (right - left) : 0);
  const rowOf = (level: NullableRiskLevel): ProfileRow => {
    const position = rows.indexOf(level);
    return { level, y: top + rowHeight * position + rowHeight / 2 };
  };
  const points = route.checkpoints.map((checkpoint): ProfilePoint => ({
    index: checkpoint.index,
    x: xOf(checkpoint.distance_mi),
    y: rowOf(checkpoint.risk.level).y,
    level: checkpoint.risk.level,
  }));
  const spacing = tickSpacing(total);
  const ticks: { miles: number; x: number }[] = [];
  for (let miles = 0; miles <= total; miles += spacing) ticks.push({ miles, x: xOf(miles) });
  const [first, ...rest] = points;
  const path =
    first === undefined
      ? ""
      : rest.reduce(
          (d, point) => `${d} H ${point.x.toFixed(2)} V ${point.y.toFixed(2)}`,
          `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`,
        );
  return {
    width,
    height,
    left,
    right,
    top,
    bottom,
    rowHeight,
    rows: rows.map(rowOf),
    points,
    ticks,
    path,
  };
}
