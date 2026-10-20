import type { ReactElement, ReactNode } from "react";

import { cx } from "../../foundation/cx";
import { typography } from "../_shared/typography";
import styles from "./Stat.module.css";

/** Props for {@link Stat}. */
export interface StatProps {
  /** What is measured, shown above the value in the overline style. */
  readonly label: ReactNode;
  /** The measured value, for example `512.4`. */
  readonly value: ReactNode;
  /** Unit shown after the value in secondary body-sm text, for example `mi`. */
  readonly unit?: ReactNode;
  /** Optional comparison text under the value, for example `12 min longer than Route A`. */
  readonly delta?: ReactNode;
}

/**
 * One headline figure: overline label above a large data value with an optional unit. It is a
 * description list (`dl` > `div` > `dt` + `dd`), so the label and the value are associated for
 * assistive technology; the delta is a second `dd` of the same term.
 */
export function Stat({ label, value, unit, delta }: StatProps): ReactElement {
  return (
    <dl className={cx(styles.stat)}>
      <div className={cx(styles.group)}>
        <dt className={cx(styles.label, typography.overline)}>{label}</dt>
        <dd className={cx(styles.value, typography.dataLg)}>
          {value}
          {unit === undefined ? null : (
            <span className={cx(styles.unit, typography.bodySm)}> {unit}</span>
          )}
        </dd>
        {delta === undefined ? null : (
          <dd className={cx(styles.delta, typography.bodySm)}>{delta}</dd>
        )}
      </div>
    </dl>
  );
}
