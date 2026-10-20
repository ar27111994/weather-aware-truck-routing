import type { ReactElement, ReactNode } from "react";
import { SwitchButton, SwitchField } from "react-aria-components";
import type { SwitchFieldProps } from "react-aria-components";

import { cx } from "../../foundation/cx";
import styles from "./Switch.module.css";

export interface SwitchProps extends Omit<
  SwitchFieldProps,
  "className" | "style" | "children" | "render" | "slot"
> {
  /** The label, shown to the right of the track. Always required: a switch must be named. */
  readonly children: ReactNode;
  readonly className?: string;
}

/** On/off setting that applies at once, such as "Show forecast map" (DESIGN.md section 10). */
export function Switch({ children, className, ...rest }: SwitchProps): ReactElement {
  return (
    <SwitchField {...rest} className={cx(styles["field"], className)}>
      <SwitchButton className={cx(styles["switch"])}>
        <span className={styles["track"]} aria-hidden="true">
          <span className={styles["thumb"]} />
        </span>
        <span className={styles["label"]}>{children}</span>
      </SwitchButton>
    </SwitchField>
  );
}
