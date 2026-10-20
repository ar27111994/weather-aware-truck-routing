import type { LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Button, ToggleButton } from "react-aria-components";
import type { ButtonProps, ToggleButtonProps } from "react-aria-components";

import { cx } from "../../foundation/cx";
import { Icon } from "../Icon";
import styles from "./Chip.module.css";

interface ChipBase {
  /** Icon before the label (Lucide, imported by name). */
  readonly leadingIcon?: LucideIcon;
  readonly className?: string;
  readonly children?: ReactNode;
}

export interface ChipProps
  extends
    ChipBase,
    Omit<ToggleButtonProps, "className" | "style" | "children" | "render" | "slot"> {}

export interface ActionChipProps
  extends
    ChipBase,
    Omit<ButtonProps, "className" | "style" | "children" | "render" | "slot" | "isPending"> {}

/** Height 32 px (44 px below 1024 px wide), radius control, 1 px control border. */
function content(leadingIcon: LucideIcon | undefined, children: ReactNode): ReactElement {
  return (
    <>
      {leadingIcon === undefined ? null : <Icon icon={leadingIcon} size={16} />}
      {children}
    </>
  );
}

/**
 * Filter or preset chip: a toggle. Selected is an ink fill. Wraps the React Aria ToggleButton, so
 * it is a `button` with `aria-pressed` that Space and Enter both toggle.
 */
export function Chip({ leadingIcon, className, children, ...rest }: ChipProps): ReactElement {
  return (
    <ToggleButton {...rest} className={cx(styles.chip, className)}>
      {content(leadingIcon, children)}
    </ToggleButton>
  );
}

/**
 * One-shot quick chip such as "Now" or "+3 h": it sets a value and announces it through the field,
 * so it is a plain button and never holds a pressed state.
 */
export function ActionChip({
  leadingIcon,
  className,
  children,
  ...rest
}: ActionChipProps): ReactElement {
  return (
    <Button {...rest} className={cx(styles.chip, className)}>
      {content(leadingIcon, children)}
    </Button>
  );
}
