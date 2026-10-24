import { CircleCheck, CircleX, Info, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactElement,
  type RefObject,
} from "react";
import {
  UNSTABLE_ToastQueue as AriaToastQueue,
  UNSTABLE_ToastRegion as AriaToastRegion,
} from "react-aria-components";
import type { QueuedToast } from "react-stately";

import { cx } from "../../foundation/cx";
import { typography } from "../_shared/typography";
import { Button } from "../Button";
import { IconButton } from "../IconButton";
import { VisuallyHidden } from "../VisuallyHidden";
import styles from "./Toast.module.css";

/** Optional action shown as a button inside a toast. Pressing it runs `onAction`, then closes. */
export interface ToastAction {
  /** Button text. */
  readonly label: string;
  /** Called when the button is pressed. */
  readonly onAction: () => void;
}

/**
 * Options for {@link toast}. A toast with an action never times out (an action that disappears is a
 * time limit on functionality, WCAG 2.2.1), so `action` and `timeout` exclude each other.
 */
export type ToastOptions =
  | {
      /** Action button next to the message. The toast stays until the action or close is pressed. */
      readonly action: ToastAction;
      readonly timeout?: never;
    }
  | {
      readonly action?: undefined;
      /** Auto-dismiss delay in ms. Defaults: 5000 (success, info); none for errors. */
      readonly timeout?: number;
    };

type ToastKind = "success" | "error" | "info";

interface ToastContentValue {
  readonly kind: ToastKind;
  readonly message: string;
  readonly action: ToastAction | undefined;
}

/**
 * Auto-dismiss delay of success and info toasts without an action: the floor that React Aria
 * documents for toasts (DESIGN.md section 10, Toast).
 */
const AUTO_DISMISS_MS = 5000;

const queue = new AriaToastQueue<ToastContentValue>({ maxVisibleToasts: 1 });

function enqueue(
  kind: ToastKind,
  message: string,
  options: ToastOptions | undefined,
  defaultTimeout: number | undefined,
): string {
  const action = options?.action;
  const timeout = action === undefined ? (options?.timeout ?? defaultTimeout) : undefined;
  return queue.add({ kind, message, action }, timeout === undefined ? {} : { timeout });
}

/**
 * The app-wide toast queue. Each method returns the toast's key. Only one toast is visible at a
 * time; the newest shows first and the others wait behind it. Render {@link ToastRegion} once.
 */
export const toast = {
  /** Shows a success message; without an action it dismisses itself after 5 s. */
  success: (message: string, options?: ToastOptions): string =>
    enqueue("success", message, options, AUTO_DISMISS_MS),
  /** Shows an error message; stays until the user closes it (unless `timeout` is given). */
  error: (message: string, options?: ToastOptions): string =>
    enqueue("error", message, options, undefined),
  /** Shows a neutral message; without an action it dismisses itself after 5 s. */
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
  /** Accessible name of each toast's close button (the app passes microcopy `toast.close`). */
  readonly closeLabel: string;
}

const ICONS = { success: CircleCheck, error: CircleX, info: Info } as const;

const subscribe = (onChange: () => void): (() => void) => queue.subscribe(onChange);
const visibleToasts = (): readonly QueuedToast<ToastContentValue>[] => queue.visibleToasts;

/**
 * The polite live region every toast is heard through (DESIGN.md section 10, Toast). It is mounted
 * with the page, before the first toast, because a live region that appears together with its text
 * is not announced by some screen readers; the toast itself is plain markup, not a live region.
 *
 * Some screen readers also skip a region whose text did not change, so "Link copied" twice would be
 * heard once. The message is written into an element keyed by the toast: each toast is a new node,
 * an addition to the region even when its words repeat the last toast's.
 */
function Announcement(): ReactElement {
  const [shown] = useSyncExternalStore(subscribe, visibleToasts, visibleToasts);
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className={cx(styles.announcement)}>
      {shown === undefined ? null : (
        <VisuallyHidden key={shown.key}>{shown.content.message}</VisuallyHidden>
      )}
    </div>
  );
}

interface ToastItemProps {
  readonly queued: QueuedToast<ToastContentValue>;
  readonly closeLabel: string;
  /** Where focus was before it entered the region; see {@link ToastRegion}. */
  readonly opener: RefObject<HTMLElement | null>;
}

function ToastItem({ queued, closeLabel, opener }: ToastItemProps): ReactElement {
  const { kind, message, action } = queued.content;
  const { key, timer, timeout } = queued;
  const Icon = ICONS[kind];

  // As React Aria's useToast does: the timer runs while the toast is shown and pauses when it hides.
  useEffect(() => {
    if (timer === undefined || timeout === undefined) {
      return undefined;
    }
    timer.reset(timeout);
    return () => {
      timer.pause();
    };
  }, [timer, timeout]);

  // The region only moves focus on to the next toast by looking for role="alertdialog", which this
  // markup has not got. A toast that goes away with focus inside would drop it on the page, so it
  // hands focus back to the opener while it is still attached.
  const handFocusBack = useCallback(
    (surface: HTMLDivElement) => () => {
      if (surface.contains(document.activeElement)) {
        opener.current?.focus();
      }
    },
    [opener],
  );

  return (
    <div ref={handFocusBack} className={cx(styles.toast)}>
      <div className={cx(styles.content)}>
        <Icon size={20} aria-hidden="true" className={cx(styles.icon)} />
        <p className={cx(styles.message, typography.body)}>{message}</p>
      </div>
      {action === undefined ? null : (
        <Button
          variant="ghost"
          size="sm"
          onPress={() => {
            action.onAction();
            queue.close(key);
          }}
        >
          {action.label}
        </Button>
      )}
      <IconButton
        icon={X}
        label={closeLabel}
        onPress={() => {
          queue.close(key);
        }}
        size="sm"
        showTooltip={false}
      />
    </div>
  );
}

/**
 * The viewport-fixed region that shows {@link toast} messages: ink surface, one toast at a time,
 * bottom centre. Hovering or focusing the region pauses the auto-dismiss timer. Every toast is also
 * announced once, politely, by a live region that this component keeps mounted. Render it once,
 * near the root of the app.
 */
export function ToastRegion({ closeLabel }: ToastRegionProps): ReactElement {
  // The element that had focus before focus entered the region. It is read when a toast that holds
  // focus goes away (see ToastItem).
  const opener = useRef<HTMLElement | null>(null);
  const rememberOpener = useCallback((region: HTMLDivElement) => {
    const onFocusIn = (event: FocusEvent): void => {
      const from = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
      if (from === null || !region.contains(from)) {
        opener.current = from;
      }
    };
    region.addEventListener("focusin", onFocusIn);
    return () => {
      region.removeEventListener("focusin", onFocusIn);
    };
  }, []);

  return (
    <>
      <Announcement />
      <AriaToastRegion queue={queue} className={cx(styles.region)} ref={rememberOpener}>
        {({ toast: queued }) => (
          <ToastItem queued={queued} closeLabel={closeLabel} opener={opener} />
        )}
      </AriaToastRegion>
    </>
  );
}
