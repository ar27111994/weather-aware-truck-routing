import { useEffect, useId, useState, type ReactElement } from "react";

import { cls } from "../../cls";
import { copy } from "../../copy";
import { typography } from "../_shared/typography";
import { layoutSegments } from "./geometry";
import { RISK_LEVEL_META, RISK_LEVELS, type RiskLevel, type RiskPatternKind } from "./riskLevels";
import styles from "./StackedBar.module.css";

export { RISK_LEVELS, type RiskLevel };

/** Bar width in px before the real width is measured (first paint, server rendering). */
const FALLBACK_WIDTH = 320;
/** Mirrors `--c-stacked-bar-gap`: the geometry needs the number, the CSS token cannot be read here. */
const GAP_PX = 1;
/** Mirrors `--c-stacked-bar-min-segment`. */
const MIN_SEGMENT_PX = 3;

const milesFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Props for {@link StackedBar}. */
export interface StackedBarProps {
  /** Miles per risk level, Unknown included. Zero-mile levels are not drawn or listed. */
  readonly miles: Readonly<Record<RiskLevel, number>>;
}

interface PatternProps {
  readonly id: string;
  readonly kind: Exclude<RiskPatternKind, "solid">;
  readonly token: string;
}

/** One SVG `<pattern>` with the 6 px geometry of DESIGN.md section 4 rule 4 (5 px for Unknown). */
function Pattern({ id, kind, token }: PatternProps): ReactElement {
  const ink = {
    fill: `var(--risk-${token}-on-fill)`,
    fillOpacity: "var(--risk-pattern-alpha)",
  };
  switch (kind) {
    case "dots":
      return (
        <pattern id={id} width={6} height={6} patternUnits="userSpaceOnUse">
          <circle cx={3} cy={3} r={1.1} style={ink} />
        </pattern>
      );
    case "hatch-45":
      return (
        <pattern
          id={id}
          width={6}
          height={6}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width={6} height={1.5} style={ink} />
        </pattern>
      );
    case "cross-hatch":
      return (
        <pattern
          id={id}
          width={6}
          height={6}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width={6} height={1.5} style={ink} />
          <rect width={1.5} height={6} style={ink} />
        </pattern>
      );
    case "bars-horizontal":
      return (
        <pattern id={id} width={6} height={6} patternUnits="userSpaceOnUse">
          <rect width={6} height={2} style={ink} />
        </pattern>
      );
    case "hatch-135":
      return (
        <pattern
          id={id}
          width={5}
          height={5}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(-45)"
        >
          <rect width={5} height={1} style={ink} />
        </pattern>
      );
  }
}

/**
 * Miles-by-risk-level bar: 12 px tall, one segment per non-zero level in Low to Unknown order,
 * each a level fill with its pattern on top, plus a text row ("Low 480.1 mi") that carries the
 * same information in words. The SVG is an `img` named by that same text.
 */
export function StackedBar({ miles }: StackedBarProps): ReactElement {
  const patternScope = useId().replaceAll(":", "");
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);

  useEffect(() => {
    if (container === null) {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        setWidth(entry.contentRect.width);
      });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [container]);

  const segments = layoutSegments(miles, width, GAP_PX, MIN_SEGMENT_PX);
  const parts = segments.map(
    (segment) =>
      `${RISK_LEVEL_META[segment.level].label} ${milesFormat.format(segment.miles)} ${copy.form.interval.unit}`,
  );
  const ariaLabel = [copy.route.milesByLevel, parts.join(", ")].filter(Boolean).join(": ");

  return (
    <div className={cls(styles["root"])}>
      <div ref={setContainer} className={cls(styles["barBox"])}>
        <svg
          className={cls(styles["bar"])}
          role="img"
          aria-label={ariaLabel}
          width="100%"
          height="100%"
        >
          <defs>
            {segments.map(({ level }) => {
              const meta = RISK_LEVEL_META[level];
              return meta.pattern === "solid" ? null : (
                <Pattern
                  key={level}
                  id={`${patternScope}-${meta.token}`}
                  kind={meta.pattern}
                  token={meta.token}
                />
              );
            })}
          </defs>
          {segments.map((segment) => {
            const meta = RISK_LEVEL_META[segment.level];
            return (
              <g key={segment.level} className={cls(styles["segment"])}>
                <rect
                  x={segment.x}
                  width={segment.width}
                  height="100%"
                  style={{ fill: `var(--risk-${meta.token}-fill)` }}
                />
                {meta.pattern === "solid" ? null : (
                  <rect
                    x={segment.x}
                    width={segment.width}
                    height="100%"
                    fill={`url(#${patternScope}-${meta.token})`}
                  />
                )}
                <rect
                  className={cls(styles["outline"])}
                  x={segment.x}
                  width={segment.width}
                  height="100%"
                  fill="none"
                />
              </g>
            );
          })}
        </svg>
      </div>
      <ul className={cls(styles["legend"], typography.dataSm)}>
        {segments.map((segment, index) => {
          const meta = RISK_LEVEL_META[segment.level];
          const Icon = meta.icon;
          return (
            <li key={segment.level} className={cls(styles["item"])}>
              <Icon
                size={14}
                aria-hidden="true"
                style={{
                  fill: `var(--risk-${meta.token}-fill)`,
                  stroke: `var(--risk-${meta.token}-fill)`,
                }}
              />
              {parts[index]}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
