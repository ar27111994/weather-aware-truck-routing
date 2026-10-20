import { CircleX, Info, OctagonX, TriangleAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { cx } from "../../foundation/cx";
import { Icon } from "../Icon";
import styles from "./Banner.module.css";

export type BannerVariant = "info" | "warning" | "danger" | "scenario" | "no-safe-route";

export interface BannerProps {
  /**
   * `info` and `warning` are polite notices (partial weather, fewer than 3 routes), `danger` is an
   * error, `scenario` marks simulated weather, and `no-safe-route` is the do-not-depart result.
   */
  readonly variant: BannerVariant;
  /** One short line: what this is. */
  readonly title: string;
  /** Detail, in body-sm. */
  readonly children?: ReactNode;
  /** An optional action, such as a Button. */
  readonly action?: ReactNode;
  readonly className?: string;
}

const ICONS: Readonly<Record<BannerVariant, LucideIcon>> = {
  info: Info,
  warning: TriangleAlert,
  danger: CircleX,
  scenario: Info,
  "no-safe-route": OctagonX,
};

/** Errors and the do-not-depart result interrupt (`alert`); everything else waits its turn (`status`). */
const ROLES: Readonly<Record<BannerVariant, "status" | "alert">> = {
  info: "status",
  warning: "status",
  danger: "alert",
  scenario: "status",
  "no-safe-route": "alert",
};

/**
 * Full-width notice with an icon, a title, an optional body and an optional action (DESIGN.md
 * section 10). The scenario variant is hatched and dashed so simulated weather can never be taken
 * for a forecast, and the no-safe-route variant is the one solid, inverted block in the product.
 */
export function Banner({ variant, title, children, action, className }: BannerProps): ReactElement {
  return (
    <div role={ROLES[variant]} data-variant={variant} className={cx(styles["banner"], className)}>
      {variant === "scenario" ? <span className={styles["stripe"]} aria-hidden="true" /> : null}
      <Icon
        icon={ICONS[variant]}
        size={variant === "no-safe-route" ? 24 : 20}
        className={styles["icon"]}
      />
      <div className={styles["content"]}>
        <p className={styles["title"]}>{title}</p>
        {children === undefined ? null : <div className={styles["body"]}>{children}</div>}
      </div>
      {action === undefined ? null : <div className={styles["action"]}>{action}</div>}
    </div>
  );
}
