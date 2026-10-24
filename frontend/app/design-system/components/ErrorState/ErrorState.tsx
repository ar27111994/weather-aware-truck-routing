import { CircleX } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { cx } from "../../foundation/cx";
import { isStringKey, t, type StringKey, type StringParams } from "../../foundation/strings";
import { Button } from "../Button";
import { CopyButton } from "../CopyButton";
import { Icon } from "../Icon";
import styles from "./ErrorState.module.css";

/** Reads the problem code out of an `error.<code>.title` microcopy key. */
type CodeOf<Key extends string> = Key extends `error.${infer Code}.title` ? Code : never;

/** The API problem codes that have their own copy, read off the keys in microcopy.json. */
export type ProblemCode = CodeOf<StringKey>;

/** Title and body of one error, with their `{placeholders}` filled in. */
export interface ErrorCopy {
  readonly title: string;
  readonly body: string;
}

function isProblemCode(code: string): code is ProblemCode {
  return isStringKey(`error.${code}.title`) && isStringKey(`error.${code}.body`);
}

/**
 * Title and body for an API problem `code`. A code without its own copy, and a missing code, get
 * the generic copy. `params` fills the placeholders the body holds (`{seconds}`, `{minutes}`...).
 *
 * @throws {Error} If the chosen copy has a placeholder that `params` does not fill (a developer
 *   error: the caller maps each code to the values its copy needs).
 */
export function errorCopyFor(code?: string, params: StringParams = {}): ErrorCopy {
  const known: ProblemCode = code !== undefined && isProblemCode(code) ? code : "generic";
  return { title: t(`error.${known}.title`, params), body: t(`error.${known}.body`, params) };
}

/** Props for {@link ErrorState}. */
export interface ErrorStateProps {
  /** API problem code; picks the title and body from microcopy. */
  readonly code?: string;
  /** Replaces the title of the code's copy. */
  readonly title?: string;
  /** Replaces the body of the code's copy. */
  readonly children?: ReactNode;
  /** Values for the placeholders of the code's copy, for example `{ minutes: 12 }`. */
  readonly values?: StringParams;
  /** Shows the primary "Try again" button and runs this when it is pressed. */
  readonly onRetry?: () => void;
  /** Label of the retry button. Defaults to microcopy `error.retry`. */
  readonly retryLabel?: string;
  /** Shows the secondary "Edit trip" button and runs this when it is pressed. */
  readonly onEdit?: () => void;
  /** Label of the edit button. Defaults to microcopy `error.editTrip`. */
  readonly editLabel?: string;
  /** Request id for support: shown as "Reference {id}" with a button that copies it. */
  readonly requestId?: string;
  /**
   * Seconds left until a retry is allowed (the `Retry-After` header). While above 0 the retry
   * button is disabled and `{seconds}` in the body shows this value. Feed it from
   * `useRetryCountdown` to tick; the panel itself keeps no timer, so it never re-announces.
   */
  readonly retryAfterSeconds?: number;
  /** Toast after the reference was copied. Defaults to microcopy `error.referenceCopied`. */
  readonly referenceCopiedMessage?: string;
  /** Toast when copying the reference failed. Defaults to microcopy `error.referenceCopyFailed`. */
  readonly referenceCopyFailedMessage?: string;
  readonly className?: string;
}

/**
 * Failure panel: a danger icon, a title and body for the problem code, "Try again" and "Edit trip"
 * actions and a copyable request reference. It is an alert, announced once when it appears; a
 * ticking `retryAfterSeconds` updates the body silently.
 */
export function ErrorState({
  code,
  title,
  children,
  values,
  onRetry,
  retryLabel = t("error.retry"),
  onEdit,
  editLabel = t("error.editTrip"),
  requestId,
  retryAfterSeconds,
  referenceCopiedMessage = t("error.referenceCopied"),
  referenceCopyFailedMessage = t("error.referenceCopyFailed"),
  className,
}: ErrorStateProps): ReactElement {
  const copy = errorCopyFor(code, { ...values, seconds: retryAfterSeconds ?? 0 });
  return (
    <div role="alert" className={cx(styles.root, className)}>
      <Icon icon={CircleX} size={24} className={cx(styles.icon)} />
      <div className={cx(styles.content)}>
        <p className={cx(styles.title)}>{title ?? copy.title}</p>
        <p
          className={cx(styles.body)}
          {...(retryAfterSeconds === undefined ? {} : { "aria-live": "off" })}
        >
          {children ?? copy.body}
        </p>
        {onRetry === undefined && onEdit === undefined ? null : (
          <div className={cx(styles.actions)}>
            {onRetry === undefined ? null : (
              <Button
                variant="primary"
                isDisabled={retryAfterSeconds !== undefined && retryAfterSeconds > 0}
                onPress={onRetry}
              >
                {retryLabel}
              </Button>
            )}
            {onEdit === undefined ? null : <Button onPress={onEdit}>{editLabel}</Button>}
          </div>
        )}
        {requestId === undefined ? null : (
          <div className={cx(styles.reference)}>
            <span>{t("error.reference", { id: requestId })}</span>
            <CopyButton
              text={requestId}
              size="sm"
              successMessage={referenceCopiedMessage}
              failureMessage={referenceCopyFailedMessage}
            >
              {t("error.copyReference")}
            </CopyButton>
          </div>
        )}
      </div>
    </div>
  );
}
