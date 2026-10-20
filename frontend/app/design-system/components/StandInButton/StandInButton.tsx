import { X } from "lucide-react";
import type { ReactElement } from "react";
import { Button, type ButtonProps } from "react-aria-components";

import { cx } from "../../foundation/cx";
import { Icon } from "../Icon";
import styles from "./StandInButton.module.css";

/** Props for {@link StandInCloseButton}. */
export interface StandInCloseButtonProps extends Omit<
  ButtonProps,
  "className" | "style" | "children"
> {
  /** Accessible name. Required: the button shows only an icon. */
  readonly "aria-label": string;
}

/**
 * Stand-in for T6a's `IconButton` (DESIGN.md section 10, Actions): a 44 px (32 px on desktop)
 * square ghost button with a Lucide X. Dialog and Toast use it for their close button. Replace
 * every import of this module with `IconButton` once T6a lands, then delete the folder.
 */
export function StandInCloseButton(props: StandInCloseButtonProps): ReactElement {
  return (
    <Button {...props} className={cx(styles["button"])}>
      <Icon icon={X} size={20} />
    </Button>
  );
}
