import type { ReactElement, ReactNode } from "react";
import { VisuallyHidden as AriaVisuallyHidden } from "react-aria";

export interface VisuallyHiddenProps {
  readonly children: ReactNode;
  /** Element to render. */
  readonly elementType?: "span" | "div";
  /** Becomes visible while it or a descendant has focus, for skip links. */
  readonly isFocusable?: boolean;
}

/** Hides content visually while keeping it available to screen readers (the standard clip pattern). */
export function VisuallyHidden({
  children,
  elementType = "span",
  isFocusable = false,
}: VisuallyHiddenProps): ReactElement {
  return (
    <AriaVisuallyHidden elementType={elementType} isFocusable={isFocusable}>
      {children}
    </AriaVisuallyHidden>
  );
}
