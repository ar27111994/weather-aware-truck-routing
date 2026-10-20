import type { ReactElement, ReactNode } from "react";
import { Dialog, DialogTrigger, OverlayArrow, Popover as AriaPopover } from "react-aria-components";
import type { PopoverProps as AriaPopoverProps } from "react-aria-components";

import { cx } from "../../foundation/cx";
import styles from "./Popover.module.css";

/** `checkpoint` is the 320 px map popover; `content` fits what is inside. */
export type PopoverWidth = "content" | "checkpoint";

export interface PopoverProps extends Pick<
  AriaPopoverProps,
  "isOpen" | "defaultOpen" | "onOpenChange" | "placement" | "triggerRef"
> {
  /** Accessible name of the dialog, e.g. "Checkpoint 7". Always required. */
  readonly label: string;
  readonly children: ReactNode;
  /**
   * The pressable element that opens the popover (a Button or IconButton). Leave it out to anchor
   * the popover to an element you already have: pass `triggerRef` and control it with `isOpen`.
   */
  readonly trigger?: ReactElement;
  readonly width?: PopoverWidth;
  readonly className?: string;
}

/** Gap between the trigger and the popover, in px (DESIGN.md section 10, Popover). */
const POPOVER_OFFSET = 12;

/**
 * Raised, non-modal panel anchored to its trigger (DESIGN.md section 10). It is a dialog, so focus
 * moves into it, Escape and an outside press close it, and focus returns to the trigger.
 */
export function Popover({
  label,
  children,
  trigger,
  width = "content",
  placement = "bottom",
  className,
  triggerRef,
  ...openProps
}: PopoverProps): ReactElement {
  const anchor = triggerRef === undefined ? {} : { triggerRef };
  const renderPopover = (extra: Partial<PopoverProps>): ReactElement => (
    <AriaPopover
      {...anchor}
      {...extra}
      placement={placement}
      offset={POPOVER_OFFSET}
      data-width={width}
      className={cx(styles["popover"], className)}
    >
      <OverlayArrow className={styles["arrow"]}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M0 0 L6 6 L12 0" />
        </svg>
      </OverlayArrow>
      <Dialog aria-label={label} className={styles["dialog"]}>
        {children}
      </Dialog>
    </AriaPopover>
  );
  if (trigger === undefined) {
    return renderPopover(openProps);
  }
  return (
    <DialogTrigger {...openProps}>
      {trigger}
      {renderPopover({})}
    </DialogTrigger>
  );
}
