import type { ReactElement, ReactNode } from "react";
import { Switch as AriaSwitch } from "react-aria-components";
import type { SwitchProps as AriaSwitchProps } from "react-aria-components";

import { cx } from "../../foundation/cx";
import styles from "./Switch.module.css";

export interface SwitchProps extends Omit<
  AriaSwitchProps,
  "className" | "style" | "children" | "render" | "slot"
> {
  /** The label, shown to the right of the track. Always required: a switch must be named. */
  readonly children: ReactNode;
  readonly className?: string;
}

/** On/off setting that applies at once, such as "Show forecast map" (DESIGN.md section 10). */
export function Switch({ children, className, ...rest }: SwitchProps): ReactElement {
  return (
    <AriaSwitch {...rest} className={cx(styles["switch"], className)}>
      <span className={styles["track"]} aria-hidden="true">
        <span className={styles["thumb"]} />
      </span>
      <span className={styles["label"]}>{children}</span>
    </AriaSwitch>
  );
}
