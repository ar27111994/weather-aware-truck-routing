import { CircleCheck, CircleX } from "lucide-react";
import type { ReactElement } from "react";

import { cx } from "../../foundation/cx";
import { t } from "../../foundation/strings";
import { Icon } from "../Icon";
import { Spinner } from "../Spinner";
import { VisuallyHidden } from "../VisuallyHidden";
import styles from "./ProgressSteps.module.css";

/** Where a step is in its request: not started, running, finished or failed. */
export type ProgressStatus = "pending" | "active" | "done" | "failed";

/** One step of a {@link ProgressSteps} list. */
export interface ProgressStepItem {
  /** Stable key of the step. */
  readonly id: string;
  /** What the step does, for example `t("progress.server")`. */
  readonly label: string;
  /** Derived by the caller from the real request lifecycle; the component never advances it. */
  readonly status: ProgressStatus;
  /** Sub-labels shown under the step, for example the three stages the server runs in one request. */
  readonly details?: readonly string[];
  /** Seconds since the step started; shown only while the step is active, fraction dropped. */
  readonly elapsedSeconds?: number;
}

export interface ProgressStepsProps {
  /** Accessible name of the list, for example `t("progress.label")`. */
  readonly label: string;
  readonly steps: readonly ProgressStepItem[];
  readonly className?: string;
}

/**
 * The step the live region talks about: the first failure, else the first running step, else the
 * latest finished one. Nothing when no step has started.
 */
function currentStep(steps: readonly ProgressStepItem[]): ProgressStepItem | undefined {
  return (
    steps.find((step) => step.status === "failed") ??
    steps.find((step) => step.status === "active") ??
    steps.findLast((step) => step.status === "done")
  );
}

/** The one sentence the live region holds: it changes exactly when a transition is worth saying. */
function announcement(steps: readonly ProgressStepItem[]): string {
  const step = currentStep(steps);
  return step === undefined ? "" : `${step.label}: ${t(`progress.state.${step.status}`)}`;
}

function StatusIcon({ step }: { readonly step: ProgressStepItem }): ReactElement {
  switch (step.status) {
    case "pending":
      return <span className={styles.ring} aria-hidden="true" />;
    case "active":
      return <Spinner label={step.label} size={20} />;
    case "done":
      return <Icon icon={CircleCheck} size={20} />;
    case "failed":
      return <Icon icon={CircleX} size={20} />;
  }
}

function Step({ step }: { readonly step: ProgressStepItem }): ReactElement {
  const { label, status, details, elapsedSeconds } = step;
  return (
    <li className={styles.step} data-status={status}>
      <span className={styles.icon}>
        <StatusIcon step={step} />
      </span>
      <span className={styles.label}>{label}</span>
      <span className={styles.meta}>
        <span className={styles.state}>{t(`progress.state.${status}`)}</span>
        {status === "active" && elapsedSeconds !== undefined ? (
          <span className={styles.elapsed}>
            {t("progress.elapsed", { s: Math.floor(elapsedSeconds) })}
          </span>
        ) : null}
      </span>
      {details !== undefined && details.length > 0 ? (
        <ul className={styles.details}>
          {details.map((detail, index) => (
            <li key={`${String(index)}:${detail}`} className={styles.detail}>
              {detail}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Honest progress for a multi-request job (DESIGN.md section 10). It is purely presentational: the
 * caller maps each step to a real request and passes its status, so nothing here is timed or faked.
 * A visually hidden polite live region announces each transition once, as one sentence derived
 * from the props alone (the per-second elapsed counter is never announced).
 */
export function ProgressSteps({ label, steps, className }: ProgressStepsProps): ReactElement {
  return (
    <div className={cx(styles.root, className)}>
      <ol className={styles.list} aria-label={label}>
        {steps.map((step) => (
          <Step key={step.id} step={step} />
        ))}
      </ol>
      <div role="status" aria-live="polite" aria-atomic="true">
        <VisuallyHidden>{announcement(steps)}</VisuallyHidden>
      </div>
    </div>
  );
}
