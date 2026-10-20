import type { ReactElement, ReactNode } from "react";

import { cx } from "../../foundation/cx";
import styles from "./VisuallyHidden.module.css";

export interface VisuallyHiddenProps {
  readonly children: ReactNode;
  /** Element to render. */
  readonly elementType?: "span" | "div";
  /** Becomes visible while it or a descendant has focus, for skip links. */
  readonly isFocusable?: boolean;
}

/**
 * Hides content visually while keeping it available to screen readers (the standard clip pattern).
 * It is a CSS class and never an inline `style` attribute: the prerendered HTML is served under a
 * strict CSP that blocks inline styles, which would make the hidden text visible.
 */
export function VisuallyHidden({
  children,
  elementType: Tag = "span",
  isFocusable = false,
}: VisuallyHiddenProps): ReactElement {
  return <Tag className={cx(styles["hidden"], isFocusable && styles["focusable"])}>{children}</Tag>;
}
