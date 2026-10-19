import { X } from "lucide-react";
import type { ReactElement } from "react";
import { Button, type ButtonProps } from "react-aria-components";

import { cls } from "../../cls";
import { typography } from "../_shared/typography";
import styles from "./StandInButton.module.css";

/**
 * Stand-in for T6a's `Button` (DESIGN.md section 10, Actions). Swap every import of this module for
 * the real `Button` / `IconButton` once T6a lands; the props below are a subset of theirs.
 */
export interface StandInButtonProps extends Omit<ButtonProps, "className" | "style"> {
  /** Look of the button: ink fill, bordered raised fill, or transparent. Defaults to secondary. */
  readonly variant?: "primary" | "secondary" | "ghost";
  /** Height from the desktop breakpoint up: 32 px or 40 px. Touch widths are always 44 px. */
  readonly size?: "sm" | "md";
  /** `onInk` recolours the button for use on the ink toast surface. */
  readonly tone?: "default" | "onInk";
}

/** Temporary Button: React Aria button with the design's primary, secondary and ghost looks. */
export function StandInButton({
  variant = "secondary",
  size = "md",
  tone = "default",
  ...props
}: StandInButtonProps): ReactElement {
  return (
    <Button
      {...props}
      className={cls(
        styles["button"],
        typography.label,
        styles[variant],
        styles[size],
        tone === "onInk" && styles["onInk"],
      )}
    />
  );
}

/** Props for {@link StandInCloseButton}. */
export interface StandInCloseButtonProps extends Omit<
  ButtonProps,
  "className" | "style" | "children"
> {
  /** Accessible name. Required: the button shows only an icon. */
  readonly "aria-label": string;
  /** `onInk` recolours the button for use on the ink toast surface. */
  readonly tone?: "default" | "onInk";
}

/** Temporary IconButton: a 44 px (32 px on desktop) square ghost button with a Lucide X. */
export function StandInCloseButton({
  tone = "default",
  ...props
}: StandInCloseButtonProps): ReactElement {
  return (
    <Button
      {...props}
      className={cls(
        styles["button"],
        styles["icon"],
        styles["ghost"],
        tone === "onInk" && styles["onInk"],
      )}
    >
      <X size={20} aria-hidden="true" />
    </Button>
  );
}
