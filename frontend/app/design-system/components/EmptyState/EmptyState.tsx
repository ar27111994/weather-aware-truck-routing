import { useId, type ReactElement, type ReactNode } from "react";

import { cls } from "../../cls";
import { typography } from "../_shared/typography";
import styles from "./EmptyState.module.css";

/** Optional "how it works" list: the steps and the heading that names them travel together. */
export type EmptyStateSteps =
  | { readonly steps?: undefined; readonly stepsLabel?: undefined }
  | {
      /** Ordered steps, one short sentence each. */
      readonly steps: readonly string[];
      /** Heading of the steps list, for example "How it works". */
      readonly stepsLabel: string;
    };

/** Props for {@link EmptyState}. */
export type EmptyStateProps = EmptyStateSteps & {
  /** Headline, shown in the title-lg style. */
  readonly title: ReactNode;
  /** Explanatory body text. */
  readonly children: ReactNode;
  /** Call to action, for example a ghost Link. There is no illustration by design. */
  readonly action?: ReactNode;
};

/**
 * What a screen shows before there is anything to show: title, one body paragraph, an optional
 * ordered "how it works" list and an optional action. No illustration (DESIGN.md section 10).
 */
export function EmptyState({
  title,
  children,
  steps,
  stepsLabel,
  action,
}: EmptyStateProps): ReactElement {
  const stepsHeadingId = useId();
  return (
    <div className={cls(styles["root"])}>
      <h2 className={cls(styles["title"])}>{title}</h2>
      <p className={cls(styles["body"], typography.body)}>{children}</p>
      {steps === undefined ? null : (
        <section className={cls(styles["steps"])}>
          <h3 id={stepsHeadingId} className={cls(styles["stepsLabel"], typography.overline)}>
            {stepsLabel}
          </h3>
          <ol aria-labelledby={stepsHeadingId} className={cls(styles["list"], typography.body)}>
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
      )}
      {action === undefined ? null : <div className={cls(styles["action"])}>{action}</div>}
    </div>
  );
}
