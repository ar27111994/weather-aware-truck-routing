import type { ReactElement, ReactNode } from "react";

import { cls } from "../../cls";
import styles from "./demo.module.css";
import { typography } from "./typography";

/** Props for {@link DemoGrid}. */
export interface DemoGridProps {
  readonly children: ReactNode;
}

/** Responsive grid that lays out the titled states of one component demo. */
export function DemoGrid({ children }: DemoGridProps): ReactElement {
  return <div className={cls(styles["grid"])}>{children}</div>;
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
    <section className={cls(styles["state"])}>
      <h3 className={cls(styles["stateTitle"], typography.caption)}>{title}</h3>
      {children}
    </section>
  );
}
