import type { LucideIcon } from "lucide-react";
import type { ReactElement } from "react";

import { cx } from "../../foundation/cx";
import styles from "./Icon.module.css";

/** Icon sizes in px: 16, 20 and 24 only (DESIGN.md section 14). */
export type IconSize = 16 | 20 | 24;

export interface IconProps {
  /** A Lucide icon component, imported by name so unused icons are tree-shaken. */
  readonly icon: LucideIcon;
  /** Rendered size in px. */
  readonly size?: IconSize;
  /** Accessible name. Leave it out for decorative icons: they are hidden from assistive tech. */
  readonly label?: string;
  readonly className?: string;
}

/** Lucide icon with the system's one stroke width, sizes and accessibility rule. */
export function Icon({ icon: Glyph, size = 20, label, className }: IconProps): ReactElement {
  const accessibility =
    label === undefined
      ? ({ "aria-hidden": true } as const)
      : ({ role: "img", "aria-label": label } as const);
  return (
    <Glyph
      size={size}
      strokeWidth={2}
      className={cx(styles["icon"], className)}
      {...accessibility}
    />
  );
}
