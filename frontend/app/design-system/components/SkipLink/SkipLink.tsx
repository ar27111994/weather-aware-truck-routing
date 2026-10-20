import type { ReactElement, ReactNode } from "react";

import { cx } from "../../foundation/cx";
import { t } from "../../foundation/strings";
import { VisuallyHidden } from "../VisuallyHidden";
import styles from "./SkipLink.module.css";

export interface SkipLinkProps {
  /** In-page target, such as `#main`. The target must be focusable (`tabIndex={-1}`). */
  readonly href: string;
  /** Link text. Defaults to "Skip to trip planner". */
  readonly children?: ReactNode;
  readonly className?: string;
}

/**
 * First tab stop on every page: invisible until it has keyboard focus, then a fixed ink label in
 * the top-left corner (DESIGN.md section 10). A plain anchor on purpose, so it works before the
 * page has hydrated.
 */
export function SkipLink({
  href,
  children = t("app.skipLink"),
  className,
}: SkipLinkProps): ReactElement {
  return (
    <VisuallyHidden isFocusable>
      <a href={href} className={cx(styles["skipLink"], className)}>
        {children}
      </a>
    </VisuallyHidden>
  );
}
