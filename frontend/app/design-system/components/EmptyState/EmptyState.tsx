import { useId, type ReactElement, type ReactNode } from "react";
import { Heading } from "react-aria-components";

import { cx } from "../../foundation/cx";
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
  /** Level of the title heading, to fit the page's outline; the steps heading is one lower. */
  readonly headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
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
  headingLevel = 2,
  children,
  steps,
  stepsLabel,
  action,
}: EmptyStateProps): ReactElement {
  const stepsHeadingId = useId();
  return (
    <div className={cx(styles.root)}>
      <Heading level={headingLevel} className={cx(styles.title)}>
        {title}
      </Heading>
      <p className={cx(styles.body, typography.body)}>{children}</p>
      {steps === undefined ? null : (
        <section className={cx(styles.steps)}>
          <Heading
            level={Math.min(headingLevel + 1, 6)}
            id={stepsHeadingId}
            className={cx(styles.stepsLabel, typography.overline)}
          >
            {stepsLabel}
          </Heading>
          <ol aria-labelledby={stepsHeadingId} className={cx(styles.list, typography.body)}>
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
      )}
      {action === undefined ? null : <div className={cx(styles.action)}>{action}</div>}
    </div>
  );
}
