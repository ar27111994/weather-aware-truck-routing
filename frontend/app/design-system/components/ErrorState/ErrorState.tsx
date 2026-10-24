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
 * The `{placeholders}` that the copy of a problem code holds, for the codes whose copy holds any.
 * ErrorState.test.tsx reads the placeholders out of microcopy.json and checks this table against
 * them, so a string that gains a `{name}` without a line here fails the tests.
 */
const PLACEHOLDERS_OF = {
  rate_limited: ["seconds"],
  weather_capacity_exhausted: ["minutes"],
  too_many_checkpoints: ["interval"],
} as const satisfies Partial<Record<ProblemCode, readonly string[]>>;

/** Problem codes whose copy holds a `{placeholder}`. */
type CodeWithPlaceholders = keyof typeof PLACEHOLDERS_OF;

/**
 * The values `ErrorState` takes in `values` for the problem code `Code`: one for each placeholder
 * of its copy, except `{seconds}`, which the panel fills from `retryAfterSeconds`. A code that is
 * only known at run time (a `string`, as the API sends it) takes any values: the panel then shows
 * the generic copy when one is missing.
 */
export type ErrorValues<Code extends string = string> = Code extends CodeWithPlaceholders
  ? Readonly<Record<Exclude<(typeof PLACEHOLDERS_OF)[Code][number], "seconds">, string | number>>
  : StringParams;

/** `PLACEHOLDERS_OF`, looked up by any problem code. */
const PLACEHOLDER_LOOKUP: Partial<Record<ProblemCode, readonly string[]>> = PLACEHOLDERS_OF;

/** True when `params` has a value for every placeholder in the copy of `code`. */
function isFilled(code: ProblemCode, params: StringParams): boolean {
  return (PLACEHOLDER_LOOKUP[code] ?? []).every((name) => params[name] !== undefined);
}

/**
 * Title and body for an API problem `code`, with their `{placeholders}` filled in from `params`
 * (`{seconds}`, `{minutes}`...). The generic copy stands in for a code without its own copy, for a
 * missing code, and for a code whose copy holds a placeholder that `params` has no value for: the
 * panel that reports a failure must not fail itself.
 */
export function errorCopyFor(code?: string, params: StringParams = {}): ErrorCopy {
  const known: ProblemCode =
    code !== undefined && isProblemCode(code) && isFilled(code, params) ? code : "generic";
  return { title: t(`error.${known}.title`, params), body: t(`error.${known}.body`, params) };
}

/** Props for {@link ErrorState}. */
export interface ErrorStateProps<Code extends string = string> {
  /** API problem code; picks the title and body from microcopy. */
  readonly code?: Code;
  /** Replaces the title of the code's copy. */
  readonly title?: string;
  /** Replaces the body of the code's copy. */
  readonly children?: ReactNode;
  /**
   * Values for the placeholders of the code's copy, for example `{ minutes: 12 }` (see
   * {@link ErrorValues}). Needed only for the part of the copy that is shown: a caller that gives
   * `title` and `children` owes none.
   */
  readonly values?: ErrorValues<Code>;
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
export function ErrorState<Code extends string = string>({
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
}: ErrorStateProps<Code>): ReactElement {
  // Each part of the code's copy is worked out only where it is shown (`??` skips the right side
  // when the caller wrote that part), so a caller that writes both owes no values for the code.
  const params: StringParams = { ...values, seconds: retryAfterSeconds ?? 0 };
  return (
    <div role="alert" className={cx(styles.root, className)}>
      <Icon icon={CircleX} size={24} className={cx(styles.icon)} />
      <div className={cx(styles.content)}>
        <p className={cx(styles.title)}>{title ?? errorCopyFor(code, params).title}</p>
        <p
          className={cx(styles.body)}
          {...(retryAfterSeconds === undefined ? {} : { "aria-live": "off" })}
        >
          {children ?? errorCopyFor(code, params).body}
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
