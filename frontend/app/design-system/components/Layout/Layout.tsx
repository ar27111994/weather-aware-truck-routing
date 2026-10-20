import type { HTMLAttributes, ReactElement, ReactNode } from "react";

import { cx } from "../../foundation/cx";
import styles from "./Layout.module.css";

/** A key of the 4 px space scale: `4` is `--space-4`, 16 px. */
export type SpaceKey = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 16 | 20;

type LayoutElement = "div" | "section" | "ul" | "ol" | "nav" | "header" | "footer" | "article";

interface LayoutBase extends Omit<HTMLAttributes<HTMLElement>, "className" | "style"> {
  /** Gap between children as a space-scale key. Children never carry margins. */
  readonly gap?: SpaceKey;
  /** The element to render. */
  readonly as?: LayoutElement;
  readonly className?: string;
  readonly children?: ReactNode;
}

export interface StackProps extends LayoutBase {
  /** Cross-axis (horizontal) alignment of children. */
  readonly align?: "start" | "center" | "end" | "stretch";
}

export interface InlineProps extends LayoutBase {
  /** Cross-axis (vertical) alignment of children. */
  readonly align?: "start" | "center" | "end" | "stretch" | "baseline";
  /** Main-axis distribution. */
  readonly justify?: "start" | "center" | "end" | "between";
  /** Let children wrap onto further lines. */
  readonly wrap?: boolean;
}

export interface GridProps extends LayoutBase {
  /** A fixed number of equal columns, or `auto` to fill with columns of at least 220 px. */
  readonly columns?: 1 | 2 | 3 | 4 | 5 | 6 | "auto";
}

/*
 * Layout is declared with data attributes and a fixed set of CSS rules, never with inline styles:
 * the prerendered HTML is served under a strict CSP that blocks the `style` attribute.
 */

/** Vertical flow with a consistent gap (DESIGN.md section 10, Stack / Inline / Grid). */
export function Stack({
  gap = 4,
  align = "stretch",
  as: Tag = "div",
  className,
  children,
  ...rest
}: StackProps): ReactElement {
  return (
    <Tag {...rest} data-gap={gap} data-align={align} className={cx(styles.stack, className)}>
      {children}
    </Tag>
  );
}

/** Horizontal flow that can wrap, with a consistent gap. */
export function Inline({
  gap = 2,
  align = "center",
  justify = "start",
  wrap = false,
  as: Tag = "div",
  className,
  children,
  ...rest
}: InlineProps): ReactElement {
  return (
    <Tag
      {...rest}
      data-gap={gap}
      data-align={align}
      data-justify={justify}
      data-wrap={wrap ? "true" : undefined}
      className={cx(styles.inline, className)}
    >
      {children}
    </Tag>
  );
}

/** Equal-column grid, fixed or auto-filling. */
export function Grid({
  gap = 4,
  columns = "auto",
  as: Tag = "div",
  className,
  children,
  ...rest
}: GridProps): ReactElement {
  return (
    <Tag {...rest} data-gap={gap} data-columns={columns} className={cx(styles.grid, className)}>
      {children}
    </Tag>
  );
}
