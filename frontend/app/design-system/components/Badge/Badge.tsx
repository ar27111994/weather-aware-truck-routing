import { Check } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { cx } from "../../foundation/cx";
import { riskInfo } from "../../foundation/risk";
import type { ApiRiskLevel } from "../../foundation/risk";
import { Icon } from "../Icon";
import styles from "./Badge.module.css";

/** How a risk level is drawn: a filled box, a bare shape with text, or a dashed outline. */
export type RiskBadgeVariant = "solid" | "subtle" | "outline";

export interface RiskBadgeProps {
  /** A level as the API sends it. `null` (or leaving it out) is Unknown: missing weather data. */
  readonly level?: ApiRiskLevel | undefined;
  /**
   * Defaults to `solid`. Unknown ignores it: Unknown is always the dashed outline (DESIGN.md
   * section 10), so a caller that passes a level which may be `null` cannot draw it any other way.
   */
  readonly variant?: RiskBadgeVariant;
  readonly className?: string;
}

export interface NeutralBadgeProps {
  /** The ink badge for facts that are not a risk level, such as "Recommended". */
  readonly variant: "neutral";
  readonly children: ReactNode;
  /** Defaults to the check mark. */
  readonly icon?: LucideIcon;
  readonly className?: string;
}

export type BadgeProps = RiskBadgeProps | NeutralBadgeProps;

/**
 * Non-interactive badge (DESIGN.md section 10). A risk level always shows its word and its own
 * shape, never colour alone: Low circle, Moderate diamond, High triangle, Severe square, No Travel
 * octagon, Unknown dashed circle.
 */
export function Badge(props: BadgeProps): ReactElement {
  if (props.variant === "neutral") {
    return (
      <span data-variant="neutral" className={cx(styles.badge, props.className)}>
        <Icon icon={props.icon ?? Check} size={14} />
        <span>{props.children}</span>
      </span>
    );
  }
  const info = riskInfo(props.level);
  const variant = info.key === "unknown" ? "outline" : (props.variant ?? "solid");
  return (
    <span
      data-variant={variant}
      data-level={info.key}
      className={cx(styles.badge, props.className)}
    >
      <Icon icon={info.icon} size={14} className={styles.shape} />
      <span>{info.label}</span>
    </span>
  );
}
