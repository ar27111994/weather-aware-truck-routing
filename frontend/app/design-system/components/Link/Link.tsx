import { ExternalLink } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Link as AriaLink } from "react-aria-components";
import type { LinkProps as AriaLinkProps } from "react-aria-components";

import { cx } from "../../foundation/cx";
import { t } from "../../foundation/strings";
import { Icon } from "../Icon";
import { VisuallyHidden } from "../VisuallyHidden";
import styles from "./Link.module.css";

export type LinkVariant = "inline" | "nav";

export interface LinkProps extends Omit<
  AriaLinkProps,
  "className" | "style" | "children" | "render" | "isDisabled" | "target" | "rel"
> {
  /** `inline` sits in running text; `nav` is a navigation item whose current page is underlined. */
  readonly variant?: LinkVariant;
  /**
   * Opens in a new tab: adds `target="_blank"` with `rel="noopener noreferrer"`, the 12 px
   * external-link cue, and the hidden words "(opens in new tab)" for screen readers.
   */
  readonly isExternal?: boolean;
  readonly className?: string;
  readonly children?: ReactNode;
}

/** Ink text link with a hairline underline (DESIGN.md section 10). Wraps React Aria's Link. */
export function Link({
  variant = "inline",
  isExternal = false,
  className,
  children,
  ...rest
}: LinkProps): ReactElement {
  const externalProps = isExternal
    ? ({ target: "_blank", rel: "noopener noreferrer" } as const)
    : {};
  return (
    <AriaLink
      {...rest}
      {...externalProps}
      data-variant={variant}
      className={cx(styles.link, variant === "nav" && styles.nav, className)}
    >
      {children}
      {isExternal ? (
        <>
          {" "}
          <span className={styles.cue}>
            <Icon icon={ExternalLink} size={12} />
          </span>
          <VisuallyHidden>{t("footer.newTab")}</VisuallyHidden>
        </>
      ) : null}
    </AriaLink>
  );
}
