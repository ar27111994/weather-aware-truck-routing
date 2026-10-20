import { useEffect, useId, useState, type ReactElement } from "react";

import { cx } from "../../foundation/cx";
import { riskInfo, type RiskInfo, type RiskKey, type RiskPattern } from "../../foundation/risk";
import { t } from "../../foundation/strings";
import { typography } from "../_shared/typography";
import { layoutSegments, type MilesByLevel } from "./geometry";
import styles from "./StackedBar.module.css";

/** Bar width in px before the real width is measured (first paint, server rendering). */
const FALLBACK_WIDTH = 320;
/** Mirrors `--c-stacked-bar-gap`: the geometry needs the number, the CSS token cannot be read here. */
const GAP_PX = 1;
/** Mirrors `--c-stacked-bar-min-segment`. */
const MIN_SEGMENT_PX = 3;

/** `riskInfo` takes the API's `null` for Unknown; the miles record is keyed by the word. */
function infoFor(level: RiskKey): RiskInfo {
  return riskInfo(level === "unknown" ? null : level);
}

const milesFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Props for {@link StackedBar}. */
export interface StackedBarProps {
  /** Miles per risk level, Unknown included. Zero-mile levels are not drawn or listed. */
  readonly miles: MilesByLevel;
}

interface PatternProps {
  readonly id: string;
  readonly kind: Exclude<RiskPattern, "none">;
  readonly token: string;
}

/** One SVG `<pattern>` with the 6 px geometry of DESIGN.md section 4 rule 4 (5 px for Unknown). */
function Pattern({ id, kind, token }: PatternProps): ReactElement {
  // Presentation attributes, not a `style` attribute: the CSP forbids inline styles in markup.
  const ink = {
    fill: `var(--risk-${token}-on-fill)`,
    fillOpacity: "var(--risk-pattern-alpha)",
  };
  switch (kind) {
    case "dots":
      return (
        <pattern id={id} width={6} height={6} patternUnits="userSpaceOnUse">
          <circle cx={3} cy={3} r={1.1} {...ink} />
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
          <rect width={6} height={1.5} {...ink} />
        </pattern>
      );
    case "crosshatch":
      return (
        <pattern
          id={id}
          width={6}
          height={6}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width={6} height={1.5} {...ink} />
          <rect width={1.5} height={6} {...ink} />
        </pattern>
      );
    case "bars-horizontal":
      return (
        <pattern id={id} width={6} height={6} patternUnits="userSpaceOnUse">
          <rect width={6} height={2} {...ink} />
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
          <rect width={5} height={1} {...ink} />
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
    // Without a ResizeObserver (jsdom, a very old WebView) the bar keeps its default width.
    if (container === null || typeof ResizeObserver === "undefined") {
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
      `${infoFor(segment.level).label} ${milesFormat.format(segment.miles)} ${t("form.interval.unit")}`,
  );
  const ariaLabel = [t("route.milesByLevel"), parts.join(", ")].filter(Boolean).join(": ");

  return (
    <div className={cx(styles["root"])}>
      <div ref={setContainer} className={cx(styles["barBox"])}>
        <svg
          className={cx(styles["bar"])}
          role="img"
          aria-label={ariaLabel}
          width="100%"
          height="100%"
        >
          <defs>
            {segments.map(({ level }) => {
              const info = infoFor(level);
              return info.pattern === "none" ? null : (
                <Pattern
                  key={level}
                  id={`${patternScope}-${info.tokenName}`}
                  kind={info.pattern}
                  token={info.tokenName}
                />
              );
            })}
          </defs>
          {segments.map((segment) => {
            const info = infoFor(segment.level);
            return (
              <g key={segment.level}>
                <rect
                  x={segment.x}
                  width={segment.width}
                  height="100%"
                  fill={`var(--risk-${info.tokenName}-fill)`}
                />
                {info.pattern === "none" ? null : (
                  <rect
                    x={segment.x}
                    width={segment.width}
                    height="100%"
                    fill={`url(#${patternScope}-${info.tokenName})`}
                  />
                )}
                <rect
                  className={cx(styles["outline"])}
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
      <ul className={cx(styles["legend"], typography.dataSm)}>
        {segments.map((segment, index) => {
          const info = infoFor(segment.level);
          const Glyph = info.icon;
          return (
            <li key={segment.level} className={cx(styles["item"])}>
              <Glyph
                size={14}
                aria-hidden="true"
                fill={`var(--risk-${info.tokenName}-fill)`}
                stroke={`var(--risk-${info.tokenName}-fill)`}
              />
              {parts[index]}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
