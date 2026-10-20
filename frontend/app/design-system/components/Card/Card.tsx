import type { HTMLAttributes, ReactElement, ReactNode } from "react";

import { cx } from "../../foundation/cx";
import styles from "./Card.module.css";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style"> {
  /** The element to render; an `article` or `section` needs an accessible name from the caller. */
  readonly as?: "div" | "article" | "section" | "li";
  /** Selected cards get a 2 px strong inset border: a selection never shifts the layout. */
  readonly isSelected?: boolean;
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * Raised surface with a hairline border and a 4 px radius (DESIGN.md section 10). Cards inside the
 * panel carry no shadow: separation is by line.
 */
export function Card({
  as: Tag = "div",
  isSelected = false,
  className,
  children,
  ...rest
}: CardProps): ReactElement {
  return (
    <Tag
      {...rest}
      data-selected={isSelected ? "true" : undefined}
      className={cx(styles.card, className)}
    >
      {children}
    </Tag>
  );
}
