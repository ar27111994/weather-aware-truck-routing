import { CircleCheck, CircleX, Info } from "lucide-react";
import type { ReactElement } from "react";
import {
  Text,
  UNSTABLE_Toast as AriaToast,
  UNSTABLE_ToastContent as AriaToastContent,
  UNSTABLE_ToastQueue as AriaToastQueue,
  UNSTABLE_ToastRegion as AriaToastRegion,
} from "react-aria-components";

import { cx } from "../../foundation/cx";
import { typography } from "../_shared/typography";
import { Button } from "../Button";
import { StandInCloseButton } from "../StandInButton";
import styles from "./Toast.module.css";

/** Optional action shown as a button inside a toast. Pressing it runs `onAction`, then closes. */
export interface ToastAction {
  /** Button text. */
  readonly label: string;
  /** Called when the button is pressed. */
  readonly onAction: () => void;
}

/** Options for {@link toast}. */
export interface ToastOptions {
  /** Optional action button next to the message. */
  readonly action?: ToastAction;
  /** Auto-dismiss delay in ms. Defaults: 4000 (success, info); none for errors. */
  readonly timeout?: number;
}

type ToastKind = "success" | "error" | "info";

interface ToastContentValue {
  readonly kind: ToastKind;
  readonly message: string;
  readonly action: ToastAction | undefined;
}

/** Auto-dismiss delay of success and info toasts (DESIGN.md section 10, Toast). */
const AUTO_DISMISS_MS = 4000;

const queue = new AriaToastQueue<ToastContentValue>({ maxVisibleToasts: 1 });

function enqueue(
  kind: ToastKind,
  message: string,
  options: ToastOptions | undefined,
  defaultTimeout: number | undefined,
): string {
  const timeout = options?.timeout ?? defaultTimeout;
  return queue.add(
    { kind, message, action: options?.action },
    timeout === undefined ? {} : { timeout },
  );
}

/**
 * The app-wide toast queue. Each method returns the toast's key. Only one toast is visible at a
 * time; the newest shows first and the others wait behind it. Render {@link ToastRegion} once.
 */
export const toast = {
  /** Shows a success message; dismisses itself after 4 s. */
  success: (message: string, options?: ToastOptions): string =>
    enqueue("success", message, options, AUTO_DISMISS_MS),
  /** Shows an error message; stays until the user closes it (unless `timeout` is given). */
  error: (message: string, options?: ToastOptions): string =>
    enqueue("error", message, options, undefined),
  /** Shows a neutral message; dismisses itself after 4 s. */
  info: (message: string, options?: ToastOptions): string =>
    enqueue("info", message, options, AUTO_DISMISS_MS),
  /** Closes the toast with this key, visible or queued. */
  close: (key: string): void => {
    queue.close(key);
  },
  /** Drops every toast, visible and queued (for example when the route changes). */
  clear: (): void => {
    queue.clear();
  },
} as const;

/** Props for {@link ToastRegion}. */
export interface ToastRegionProps {
  /** Accessible name of each toast's close button (the design has no generic microcopy for it). */
  readonly closeLabel: string;
}

const ICONS = { success: CircleCheck, error: CircleX, info: Info } as const;

/**
 * The viewport-fixed live region that shows {@link toast} messages: ink surface, one toast at a
 * time, bottom centre. Hovering or focusing the region pauses the auto-dismiss timer. Render it
 * once, near the root of the app.
 */
export function ToastRegion({ closeLabel }: ToastRegionProps): ReactElement {
  return (
    <AriaToastRegion queue={queue} className={cx(styles["region"])}>
      {({ toast: queued }) => {
        const { kind, message, action } = queued.content;
        const Icon = ICONS[kind];
        return (
          <AriaToast toast={queued} className={cx(styles["toast"])}>
            <AriaToastContent className={cx(styles["content"])}>
              <Icon size={20} aria-hidden="true" className={cx(styles["icon"])} />
              <Text slot="title" className={cx(styles["message"], typography.body)}>
                {message}
              </Text>
            </AriaToastContent>
            {action === undefined ? null : (
              <Button
                variant="ghost"
                size="sm"
                onPress={() => {
                  action.onAction();
                  queue.close(queued.key);
                }}
              >
                {action.label}
              </Button>
            )}
            <StandInCloseButton slot="close" aria-label={closeLabel} />
          </AriaToast>
        );
      }}
    </AriaToastRegion>
  );
}
