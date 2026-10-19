import type { ReactElement, ReactNode } from "react";
import {
  Dialog as AriaDialog,
  Heading,
  Modal,
  ModalOverlay,
  type ModalOverlayProps,
} from "react-aria-components";

import { cls } from "../../cls";
import { typography } from "../_shared/typography";
import { StandInCloseButton } from "../StandInButton";
import styles from "./Dialog.module.css";

export { DialogTrigger } from "react-aria-components";

/** Props for {@link Dialog}. */
export interface DialogProps extends Pick<
  ModalOverlayProps,
  "isOpen" | "defaultOpen" | "onOpenChange"
> {
  /** Heading of the dialog. Required: it names the dialog for assistive technology. */
  readonly title: string;
  /** Body of the dialog. */
  readonly children: ReactNode;
  /**
   * Buttons shown bottom-right, in the order given (secondary first, primary last). A button with
   * `slot="close"` closes the dialog.
   */
  readonly actions?: ReactNode;
  /** Accessible name of the top-right close button. Required: the button shows only an icon. */
  readonly closeLabel: string;
  /** Whether a click on the scrim closes the dialog. Escape always closes. Defaults to true. */
  readonly isDismissable?: boolean;
}

/**
 * Modal dialog: a 480 px panel over a scrim, with a title, a close button, body content and an
 * optional actions row. React Aria traps focus, returns it to the trigger and closes on Escape.
 * Use it inside a `DialogTrigger`, or control it with `isOpen`.
 */
export function Dialog({
  title,
  children,
  actions,
  closeLabel,
  isDismissable = true,
  ...overlayProps
}: DialogProps): ReactElement {
  return (
    <ModalOverlay
      {...overlayProps}
      isDismissable={isDismissable}
      className={cls(styles["overlay"])}
    >
      <Modal className={cls(styles["modal"])}>
        <AriaDialog className={cls(styles["dialog"])}>
          <Heading slot="title" className={cls(styles["title"], typography.titleSm)}>
            {title}
          </Heading>
          <div className={cls(styles["close"])}>
            <StandInCloseButton slot="close" aria-label={closeLabel} />
          </div>
          <div className={cls(styles["body"], typography.body)}>{children}</div>
          {actions === undefined ? null : <div className={cls(styles["actions"])}>{actions}</div>}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
