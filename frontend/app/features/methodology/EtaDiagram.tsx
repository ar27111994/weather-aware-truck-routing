import type { ReactElement } from "react";

import { t } from "../../design-system/foundation/strings";
import styles from "./EtaDiagram.module.css";

/** Five checkpoints 25 miles apart on 100 miles of road, with an illustrative driving time to each. */
const CHECKPOINTS = [
  { miles: 0, elapsed: "0:00" },
  { miles: 25, elapsed: "0:28" },
  { miles: 50, elapsed: "0:57" },
  { miles: 75, elapsed: "1:25" },
  { miles: 100, elapsed: "1:54" },
] as const;

const SPACING_MILES = 25;
const ROUTE_MILES = 100;
const LEFT = 56;
const RIGHT = 584;
const ROAD_Y = 84;

/** Where a distance along the route falls across the drawing. */
function across(miles: number): number {
  return LEFT + ((RIGHT - LEFT) * miles) / ROUTE_MILES;
}

/**
 * How checkpoints, arrival times and owned miles fit together (R11): a stretch of road with a
 * checkpoint every 25 miles, the driving time to each above it, its distance below it, and the
 * stretch each one owns (halfway to its neighbours) drawn under the road in alternating tones. It
 * is a picture of the rule, so it states its meaning in its accessible name and in the caption.
 */
export function EtaDiagram(): ReactElement {
  return (
    <figure className={styles.figure}>
      <svg
        className={styles.svg}
        viewBox="0 0 640 190"
        role="img"
        aria-label={t("methodology.sampling.diagram.label")}
      >
        <text className={styles.name} x={LEFT} y={16} textAnchor="start">
          {t("methodology.sampling.diagram.origin")}
        </text>
        <text className={styles.name} x={RIGHT} y={16} textAnchor="end">
          {t("methodology.sampling.diagram.destination")}
        </text>
        {CHECKPOINTS.map(({ miles }, index) => {
          const half = SPACING_MILES / 2;
          const start = across(Math.max(0, miles - half));
          const end = across(Math.min(ROUTE_MILES, miles + half));
          return (
            <rect
              key={miles}
              className={`${styles.owned} ${index % 2 === 0 ? styles.ownedEven : styles.ownedOdd}`}
              x={start}
              y={ROAD_Y + 40}
              width={end - start}
              height={12}
            />
          );
        })}
        <line
          className={styles.road}
          x1={across(0)}
          y1={ROAD_Y}
          x2={across(ROUTE_MILES)}
          y2={ROAD_Y}
        />
        {CHECKPOINTS.map(({ miles, elapsed }) => (
          <g key={miles}>
            <text className={styles.label} x={across(miles)} y={44} textAnchor="middle">
              {t("methodology.sampling.diagram.elapsed", { time: elapsed })}
            </text>
            <line
              className={styles.leader}
              x1={across(miles)}
              y1={52}
              x2={across(miles)}
              y2={ROAD_Y - 10}
            />
            <circle className={styles.checkpoint} cx={across(miles)} cy={ROAD_Y} r={8} />
            <text className={styles.label} x={across(miles)} y={ROAD_Y + 32} textAnchor="middle">
              {t("methodology.sampling.diagram.miles", { n: miles })}
            </text>
          </g>
        ))}
        <text className={styles.name} x={LEFT} y={ROAD_Y + 80} textAnchor="start">
          {t("methodology.sampling.diagram.owned")}
        </text>
      </svg>
      <figcaption className={styles.caption}>
        {t("methodology.sampling.diagram.caption")}
      </figcaption>
    </figure>
  );
}
