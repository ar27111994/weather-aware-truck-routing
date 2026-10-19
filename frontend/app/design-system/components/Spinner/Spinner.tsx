import { LoaderCircle } from "lucide-react";
import type { ReactElement } from "react";
import { ProgressBar } from "react-aria-components";

import { cx } from "../../foundation/cx";
import { Icon } from "../Icon";
import styles from "./Spinner.module.css";

/** Spinner sizes in px (DESIGN.md section 10). */
export type SpinnerSize = 16 | 20;

export interface SpinnerProps {
  /** What is loading, e.g. "Searching". Always the accessible name, visible or not. */
  readonly label: string;
  readonly size?: SpinnerSize;
  /** Also print the label next to the icon (it stays the accessible name either way). */
  readonly showLabel?: boolean;
  readonly className?: string;
}

/** Indeterminate progress as a rotating Lucide icon; static under `prefers-reduced-motion`. */
export function Spinner({
  label,
  size = 16,
  showLabel = false,
  className,
}: SpinnerProps): ReactElement {
  return (
    <ProgressBar isIndeterminate aria-label={label} className={cx(styles["spinner"], className)}>
      <Icon icon={LoaderCircle} size={size} className={cx(styles["glyph"])} />
      {showLabel ? (
        <span className={styles["label"]} aria-hidden="true">
          {label}
        </span>
      ) : null}
    </ProgressBar>
  );
}
