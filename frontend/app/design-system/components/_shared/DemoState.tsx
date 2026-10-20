import type { ReactElement, ReactNode } from "react";

import { cx } from "../../foundation/cx";
import styles from "./demo.module.css";
import { typography } from "./typography";

/** Props for {@link DemoGrid}. */
export interface DemoGridProps {
  readonly children: ReactNode;
}

/** Responsive grid that lays out the titled states of one component demo. */
export function DemoGrid({ children }: DemoGridProps): ReactElement {
  return <div className={cx(styles.grid)}>{children}</div>;
}

/** Props for {@link DemoState}. */
export interface DemoStateProps {
  /** Name of the state shown, for example "Invalid". */
  readonly title: string;
  readonly children: ReactNode;
}

/** One titled state of a component inside a demo. */
export function DemoState({ title, children }: DemoStateProps): ReactElement {
  return (
    <section className={cx(styles.state)}>
      <h3 className={cx(styles.stateTitle, typography.caption)}>{title}</h3>
      {children}
    </section>
  );
}
