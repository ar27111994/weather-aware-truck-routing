import type { LucideIcon } from "lucide-react";
import type { ReactElement } from "react";
import { Button as AriaButton } from "react-aria-components";
import type { ButtonProps as AriaButtonProps } from "react-aria-components";

import { cx } from "../../foundation/cx";
import { Icon } from "../Icon";
import { Tooltip } from "../Tooltip";
import styles from "./IconButton.module.css";

export type IconButtonVariant = "ghost" | "secondary";
export type IconButtonSize = "sm" | "md" | "lg";

export interface IconButtonProps extends Omit<
  AriaButtonProps,
  "className" | "style" | "children" | "isPending" | "render" | "aria-label" | "aria-labelledby"
> {
  /** A Lucide icon component, imported by name. Always drawn at 20 px. */
  readonly icon: LucideIcon;
  /** The accessible name, and the tooltip text. Required: an icon alone names nothing. */
  readonly label: string;
  /** `ghost` for toolbars and map controls, `secondary` when the button needs a visible boundary. */
  readonly variant?: IconButtonVariant;
  /** Squares of 32, 40 and 44 px; every size is at least 44 px below 1024 px wide. */
  readonly size?: IconButtonSize;
  /** Show `label` as a tooltip on hover and keyboard focus. Turn off where the label is already visible. */
  readonly showTooltip?: boolean;
  readonly className?: string;
}

/** Square icon-only button with the same text as its tooltip and `aria-label` (DESIGN.md section 10). */
export function IconButton({
  icon,
  label,
  variant = "ghost",
  size = "md",
  showTooltip = true,
  className,
  ...rest
}: IconButtonProps): ReactElement {
  const button = (
    <AriaButton
      {...rest}
      aria-label={label}
      data-variant={variant}
      data-size={size}
      className={cx(styles["iconButton"], className)}
    >
      <Icon icon={icon} size={20} />
    </AriaButton>
  );
  if (!showTooltip) {
    return button;
  }
  return (
    <Tooltip content={label} isDisabled={rest.isDisabled ?? false}>
      {button}
    </Tooltip>
  );
}
