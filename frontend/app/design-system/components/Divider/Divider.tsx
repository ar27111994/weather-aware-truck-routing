import type { ReactElement } from "react";
import { Separator } from "react-aria-components";

import { cx } from "../../foundation/cx";
import styles from "./Divider.module.css";

export type DividerOrientation = "horizontal" | "vertical";

export interface DividerProps {
  /** Horizontal fills the width; vertical is a 16 px rule between inline items. */
  readonly orientation?: DividerOrientation;
  readonly className?: string;
}

/** One hairline rule (DESIGN.md section 10): separation by line first, never by shadow. */
export function Divider({ orientation = "horizontal", className }: DividerProps): ReactElement {
  return <Separator orientation={orientation} className={cx(styles.divider, className)} />;
}
