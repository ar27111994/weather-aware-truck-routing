import type { ReactElement } from "react";

import { cx } from "../../foundation/cx";
import styles from "./Skeleton.module.css";

/** Width as a share of the parent, named so a skeleton can mirror the final layout. */
export type SkeletonWidth = "full" | "three-quarters" | "half" | "third" | "quarter";

/** Height of the placeholder: a line of body text, a title, a stacked bar, or a block. */
export type SkeletonHeight = "text" | "title" | "bar" | "block";

export interface SkeletonProps {
  readonly width?: SkeletonWidth;
  readonly height?: SkeletonHeight;
  /** `circle` is a round placeholder for a plate or marker; its width follows its height. */
  readonly shape?: "rect" | "circle";
  /** More than one renders that many lines of text; the last one is shorter, like real text. */
  readonly lines?: number;
  readonly className?: string;
}

/**
 * Loading placeholder that mirrors the final layout (DESIGN.md section 10): a flat sunken shape
 * whose opacity pulses (static under reduced motion). It is hidden from assistive technology; the
 * region that holds it carries `aria-busy="true"` and says what is loading.
 */
export function Skeleton({
  width = "full",
  height = "text",
  shape = "rect",
  lines = 1,
  className,
}: SkeletonProps): ReactElement {
  if (lines > 1) {
    return (
      <div aria-hidden="true" className={cx(styles.lines, className)}>
        {Array.from({ length: lines }, (_unused, index) => (
          <span
            // The lines are anonymous and never reorder, so the position is the identity.
            key={index}
            className={styles.skeleton}
            data-shape="rect"
            data-height={height}
            data-width={index === lines - 1 ? "half" : width}
          />
        ))}
      </div>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cx(styles.skeleton, className)}
      data-shape={shape}
      data-height={height}
      data-width={width}
    />
  );
}
