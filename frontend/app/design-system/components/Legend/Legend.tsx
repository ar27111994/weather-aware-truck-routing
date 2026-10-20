import { ChevronDown } from "lucide-react";
import { useId } from "react";
import type { ReactElement, ReactNode } from "react";
import { Button, Disclosure, DisclosurePanel, Heading } from "react-aria-components";

import { cx } from "../../foundation/cx";
import { riskInfo } from "../../foundation/risk";
import type { RiskKey } from "../../foundation/risk";
import { t } from "../../foundation/strings";
import { Icon } from "../Icon";
import styles from "./Legend.module.css";

export interface LegendProps {
  /** Active field and unit: "Risk level", "Wind speed, mph", "Rain, in/hr". */
  readonly title: string;
  /** `overlay` is the 280 px map card with a shadow; `inline` is the same rows on a page. */
  readonly variant?: "overlay" | "inline";
  /** Adds a "Legend" disclosure that folds the rows away (overlay only; the page version never folds). */
  readonly isCollapsible?: boolean;
  /** Initial state of a collapsible legend. */
  readonly defaultExpanded?: boolean;
  /** Fine print under the rows, such as the boundary convention. */
  readonly footnote?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

/** The risk levels in legend order: Low to No Travel, then Unknown last (DESIGN.md section 9.9). */
const RISK_ROWS: readonly RiskKey[] = ["low", "moderate", "high", "severe", "no_travel", "unknown"];

/** Map or page legend: a titled group of rows, optionally collapsible (DESIGN.md section 9.9). */
export function Legend({
  title,
  variant = "overlay",
  isCollapsible = false,
  defaultExpanded = true,
  footnote,
  children,
  className,
}: LegendProps): ReactElement {
  const titleId = useId();
  const rows = (
    <>
      <p id={titleId} className={styles["title"]}>
        {title}
      </p>
      {children}
      {footnote === undefined ? null : <p className={styles["footnote"]}>{footnote}</p>}
    </>
  );
  if (!isCollapsible) {
    return (
      <div
        role="group"
        aria-labelledby={titleId}
        data-variant={variant}
        className={cx(styles["legend"], className)}
      >
        {rows}
      </div>
    );
  }
  return (
    <Disclosure
      defaultExpanded={defaultExpanded}
      data-variant={variant}
      className={cx(styles["legend"], className)}
    >
      <Heading level={3} className={styles["heading"]}>
        <Button slot="trigger" className={styles["trigger"]}>
          {t("legend.toggle")}
          <Icon icon={ChevronDown} size={16} className={styles["chevron"]} />
        </Button>
      </Heading>
      <DisclosurePanel className={styles["panel"]}>
        <div role="group" aria-labelledby={titleId} className={styles["rows"]}>
          {rows}
        </div>
      </DisclosurePanel>
    </Disclosure>
  );
}

export interface LegendRiskListProps {
  /** Optional band text per level, such as "under 25 mph", shown after the word. */
  readonly hints?: Partial<Readonly<Record<RiskKey, string>>>;
  readonly className?: string;
}

/**
 * The six risk rows: shape icon, a swatch with the level's fill and pattern, and the word. The
 * word, the shape and the pattern each carry the level alone, so colour is never the only cue.
 */
export function LegendRiskList({ hints = {}, className }: LegendRiskListProps): ReactElement {
  return (
    <ul className={cx(styles["list"], className)}>
      {RISK_ROWS.map((key) => {
        const info = riskInfo(key === "unknown" ? null : key);
        const hint = hints[key];
        return (
          <li key={key} className={styles["row"]}>
            <Icon icon={info.icon} size={16} />
            <span className={styles["swatch"]} data-level={key} aria-hidden="true" />
            <span className={styles["word"]}>{info.label}</span>
            {hint === undefined ? null : <span className={styles["hint"]}>{hint}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** The three weather fields that have a colour ramp. */
export type LegendField = "wind" | "rain" | "snow";

type Five<T> = readonly [T, T, T, T, T];

export interface LegendRampProps {
  readonly field: LegendField;
  /** Threshold labels printed under the start of each of the five steps ("15", "25", ...). */
  readonly ticks: Five<string>;
  /** What each step means, for screen readers ("under 25 mph", "25 to under 35", ...). */
  readonly bands: Five<string>;
  /** Unit printed after the last step. */
  readonly unit?: string;
  /** One line under the ramp, such as "Not shaded: under 15 mph". */
  readonly note?: string;
  readonly className?: string;
}

const STEPS = [1, 2, 3, 4, 5] as const;

/** Five touching swatches from low to high, with threshold labels under the joints (DESIGN.md 9.9). */
export function LegendRamp({
  field,
  ticks,
  bands,
  unit,
  note,
  className,
}: LegendRampProps): ReactElement {
  return (
    <div className={cx(styles["ramp"], className)}>
      <ol className={styles["steps"]}>
        {STEPS.map((step, index) => (
          <li key={step} className={styles["step"]} data-field={field} data-step={step}>
            <span className={styles["rampSwatch"]} aria-hidden="true" />
            <span className={styles["tick"]} aria-hidden="true">
              {ticks[index]}
            </span>
            <span className={styles["bandText"]}>{bands[index]}</span>
          </li>
        ))}
        {unit === undefined ? null : (
          <li className={styles["unit"]} aria-hidden="true">
            {unit}
          </li>
        )}
      </ol>
      {note === undefined ? null : <p className={styles["note"]}>{note}</p>}
    </div>
  );
}
