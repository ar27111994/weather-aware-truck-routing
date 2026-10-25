import type { ReactElement, ReactNode } from "react";

import { cx } from "../../foundation/cx";
import { typography } from "../_shared/typography";
import styles from "./KeyValue.module.css";

/** One label/value pair of a {@link KeyValue} list. */
export interface KeyValueEntry {
  /** Stable key of the entry: give one when entries can be reordered, else the position is used. */
  readonly id?: string;
  /** The term, shown in the overline style. */
  readonly label: ReactNode;
  /** The value, shown in the data style. */
  readonly value: ReactNode;
}

/** Props for {@link KeyValue}. */
export interface KeyValueProps {
  /** Pairs in display order. */
  readonly entries: readonly KeyValueEntry[];
  /** `stacked` puts each value under its label; `inline` aligns labels and values in two columns. */
  readonly layout?: "stacked" | "inline";
}

/**
 * Label/value list on real description-list semantics (`dl` > `div` > `dt` + `dd`), so assistive
 * technology announces each value with its label. Stacked suits popovers, inline suits cards and
 * trip details.
 */
export function KeyValue({ entries, layout = "stacked" }: KeyValueProps): ReactElement {
  return (
    <dl className={cx(styles.list)} data-layout={layout}>
      {entries.map((entry, index) => (
        <div key={entry.id ?? index} className={cx(styles.entry)}>
          <dt className={cx(styles.term, typography.overline)}>{entry.label}</dt>
          <dd className={cx(styles.value, typography.data)}>{entry.value}</dd>
        </div>
      ))}
    </dl>
  );
}
