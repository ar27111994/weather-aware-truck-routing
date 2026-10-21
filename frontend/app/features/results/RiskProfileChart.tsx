import { useId, type KeyboardEvent, type ReactElement } from "react";
import { useLocale } from "react-aria";

import type { Route } from "../../api/contract";
import { riskInfo, riskVar } from "../../design-system/foundation/risk";
import { t } from "../../design-system/foundation/strings";
import { at } from "../../lib/checked";
import { formatMiles } from "../../lib/format";
import { useHoveredCheckpoint, useTripActions } from "../../state";
import { layoutProfile, type ProfilePoint } from "./profile-geometry";
import styles from "./RiskProfileChart.module.css";
import { checkpointClock } from "./route-format";

/** Half-size of each level's marker in chart units: it grows with severity, as on the map. */
const HALF = { low: 6, moderate: 8, high: 9, severe: 9, no_travel: 11, unknown: 6 } as const;

/** An SVG path from commands and numbers, joined by spaces. */
function pathOf(...parts: readonly (string | number)[]): string {
  return parts.join(" ");
}

/** The marker of a point: its level's shape (DESIGN.md section 4), filled with the level's ink. */
function Marker({
  point,
  active,
}: {
  readonly point: ProfilePoint;
  readonly active: boolean;
}): ReactElement {
  const { x, y, level } = point;
  const paint = {
    fill: riskVar(level, "fill"),
    stroke: riskVar(level, "stroke"),
    "data-active": active ? "true" : undefined,
  };
  switch (level) {
    case "low":
      return <circle cx={x} cy={y} r={HALF.low} {...paint} />;
    case "moderate": {
      const h = HALF.moderate;
      return (
        <path
          d={pathOf("M", x, y - h, "L", x + h, y, "L", x, y + h, "L", x - h, y, "Z")}
          {...paint}
        />
      );
    }
    case "high": {
      const h = HALF.high;
      return (
        <path d={pathOf("M", x, y - h, "L", x + h, y + h, "L", x - h, y + h, "Z")} {...paint} />
      );
    }
    case "severe":
      return (
        <rect
          x={x - HALF.severe}
          y={y - HALF.severe}
          width={HALF.severe * 2}
          height={HALF.severe * 2}
          {...paint}
        />
      );
    case "no_travel": {
      const h = HALF.no_travel;
      const c = h * 0.41;
      return (
        <path
          d={pathOf(
            "M",
            x - c,
            y - h,
            "H",
            x + c,
            "L",
            x + h,
            y - c,
            "V",
            y + c,
            "L",
            x + c,
            y + h,
            "H",
            x - c,
            "L",
            x - h,
            y + c,
            "V",
            y - c,
            "Z",
          )}
          {...paint}
        />
      );
    }
    case null:
      return <circle cx={x} cy={y} r={HALF.unknown} strokeDasharray="3 2" {...paint} />;
  }
}

/** The "Low 480.1 mi, Moderate 32.3 mi" part of the chart's description: the miles at each level that has any. */
function segmentsText(route: Route): string {
  const { miles_by_level: miles, unknown_mi: unknown } = route.stats;
  const parts = (["low", "moderate", "high", "severe", "no_travel"] as const)
    .filter((level) => miles[level] > 0)
    .map((level) => `${riskInfo(level).label} ${formatMiles(miles[level])}`);
  if (unknown > 0) parts.push(`${t("risk.unknown")} ${formatMiles(unknown)}`);
  return parts.join(", ");
}

/**
 * Distance against risk level for one route (R15): every checkpoint is its level's marker at its
 * distance, joined by a step line, with Unknown in a row of its own. The chart is one tab stop and
 * a listbox of checkpoints: the arrow keys move between them, Home and End jump to the first and the
 * last, and the checkpoint under the pointer or the focus is shared with the map and the table
 * through the trip state. The Checkpoints tab holds every value as text.
 */
export function RiskProfileChart({ route }: { readonly route: Route }): ReactElement {
  const { locale } = useLocale();
  const id = useId();
  const hovered = useHoveredCheckpoint();
  const { hoverCheckpoint } = useTripActions();
  const layout = layoutProfile(route);
  const last = route.checkpoints.length - 1;
  const activeIndex =
    hovered?.routeId === route.route_id && hovered.index <= last ? hovered.index : null;
  const active = activeIndex === null ? null : at(route.checkpoints, activeIndex);
  const highest = route.checkpoints.find((c) => c.risk.level === route.stats.max_level);

  const optionLabel = (index: number): string => {
    const checkpoint = at(route.checkpoints, index);
    return t("profile.pointAria", {
      n: checkpoint.index,
      distance: formatMiles(checkpoint.distance_mi, { unit: false, locale }),
      level: riskInfo(checkpoint.risk.level).label,
      eta: checkpointClock(checkpoint, locale),
    });
  };
  const move = (index: number): void => {
    hoverCheckpoint({ routeId: route.route_id, index: Math.min(last, Math.max(0, index)) });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const here = activeIndex ?? 0;
    const target: Readonly<Record<string, number>> = {
      ArrowRight: here + 1,
      ArrowDown: here + 1,
      ArrowLeft: here - 1,
      ArrowUp: here - 1,
      Home: 0,
      End: last,
    };
    const next = Object.hasOwn(target, event.key) ? target[event.key] : undefined;
    if (next !== undefined) {
      event.preventDefault();
      move(next);
    }
  };

  return (
    <figure className={styles.figure}>
      <div
        role="listbox"
        aria-label={t("profile.title", { route: route.route_id })}
        aria-orientation="horizontal"
        aria-describedby={`${id}-desc ${id}-help`}
        aria-activedescendant={activeIndex === null ? undefined : `${id}-${String(activeIndex)}`}
        tabIndex={0}
        className={styles.listbox}
        onKeyDown={onKeyDown}
        onFocus={() => {
          move(activeIndex ?? 0);
        }}
        onBlur={() => {
          if (activeIndex !== null) hoverCheckpoint(null);
        }}
      >
        <svg
          role="none"
          viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
          className={styles.chart}
        >
          <desc id={`${id}-desc`}>
            {t("profile.desc", {
              route: route.route_id,
              segments: segmentsText(route),
              level: riskInfo(route.stats.max_level).label,
              mile: formatMiles(highest?.distance_mi ?? 0, { unit: false, locale }),
            })}
          </desc>
          {layout.rows.map((row) => (
            <g key={row.level ?? "unknown"}>
              <line
                x1={layout.left}
                x2={layout.right}
                y1={row.y}
                y2={row.y}
                className={styles.band}
              />
              <text x={layout.left - 8} y={row.y} className={styles.levelWord}>
                {riskInfo(row.level).label}
              </text>
            </g>
          ))}
          {layout.ticks.map((tick) => (
            <g key={tick.miles}>
              <line
                x1={tick.x}
                x2={tick.x}
                y1={layout.bottom}
                y2={layout.bottom + 4}
                className={styles.tick}
              />
              <text x={tick.x} y={layout.bottom + 16} className={styles.tickLabel}>
                {tick.miles}
              </text>
            </g>
          ))}
          <text
            x={(layout.left + layout.right) / 2}
            y={layout.height - 4}
            className={styles.axisTitle}
          >
            {t("profile.xAxis")}
          </text>
          {active === null ? null : (
            <line
              x1={at(layout.points, active.index).x}
              x2={at(layout.points, active.index).x}
              y1={layout.top}
              y2={layout.bottom}
              className={styles.guide}
            />
          )}
          <path d={layout.path} className={styles.step} />
          {layout.points.map((point) => (
            <g
              key={point.index}
              id={`${id}-${String(point.index)}`}
              role="option"
              aria-selected={point.index === activeIndex}
              aria-label={optionLabel(point.index)}
              className={styles.point}
              onPointerEnter={() => {
                move(point.index);
              }}
              onPointerLeave={() => {
                hoverCheckpoint(null);
              }}
            >
              <Marker point={point} active={point.index === activeIndex} />
            </g>
          ))}
        </svg>
      </div>
      <figcaption id={`${id}-help`} className={styles.caption}>
        {active === null ? t("profile.help") : optionLabel(active.index)}
        <span className={styles.fallback}> {t("profile.fallback")}</span>
      </figcaption>
    </figure>
  );
}
