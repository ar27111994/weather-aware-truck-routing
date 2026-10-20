import type { ReactElement, ReactNode } from "react";
import { Keyboard } from "react-aria-components";

import { cx } from "../../foundation/cx";
import styles from "./Kbd.module.css";

export interface KbdProps {
  /** The key. For arrows use a Lucide icon plus visually hidden words: Overpass lacks U+2190 and U+2192. */
  readonly children: ReactNode;
  readonly className?: string;
}

/** A keyboard key cap for help text, such as the timeline slider hint (DESIGN.md section 10). */
export function Kbd({ children, className }: KbdProps): ReactElement {
  return <Keyboard className={cx(styles.kbd, className)}>{children}</Keyboard>;
}
