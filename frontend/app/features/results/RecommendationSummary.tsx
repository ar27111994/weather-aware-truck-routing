import { useId, type ReactElement } from "react";

import type { Plan } from "../../api/contract";
import { SCENARIO_NOTICE } from "../../api/vocabulary";
import { Banner } from "../../design-system/components/Banner";
import { KeyValue } from "../../design-system/components/KeyValue";
import { t } from "../../design-system/foundation/strings";
import { coverageDetail, decidedByText, tradeoffText } from "./decided-by";
import styles from "./RecommendationSummary.module.css";

/**
 * Every distinct warning the plan and the recommendation carry, except the API's scenario notice,
 * which the scenario banner already says in the page's own words (R4-11).
 */
function distinctWarnings(plan: Plan): readonly string[] {
  return [...new Set([...plan.warnings, ...plan.recommendation.warnings])].filter(
    (warning) => warning !== SCENARIO_NOTICE,
  );
}

/**
 * The answer to "which route": the headline, what decided it in plain English, what it costs against
 * the fastest route, and the sentences the API wrote about every route (R5). The do-not-depart
 * banner for a plan with no clear route is {@link PlanBanners}'s, above the form.
 */
export function RecommendationSummary({ plan }: { readonly plan: Plan }): ReactElement {
  const headingId = useId();
  const { recommendation } = plan;
  const headline =
    recommendation.status === "no_safe_route"
      ? t("rec.headlineNoSafe", { route: recommendation.route_id })
      : t("rec.headline", { route: recommendation.route_id });
  const tradeoff = tradeoffText(plan);
  const coverage = coverageDetail(plan);
  const warnings = distinctWarnings(plan);
  return (
    <section aria-labelledby={headingId} className={styles.summary}>
      <h2 id={headingId} className={styles.heading}>
        {t("rec.title")}
      </h2>
      <p className={styles.headline}>{headline}</p>
      <KeyValue
        layout="inline"
        entries={[
          { label: t("rec.decidedByLabel"), value: decidedByText(recommendation.decided_by) },
        ]}
      />
      {tradeoff === null ? null : <p className={styles.tradeoff}>{tradeoff}</p>}
      {coverage === null ? null : <p className={styles.detail}>{coverage}</p>}
      {recommendation.rationale.length === 0 ? null : (
        <ul className={styles.rationale}>
          {recommendation.rationale.map((sentence, index) => (
            <li key={`${String(index)}-${sentence}`}>{sentence}</li>
          ))}
        </ul>
      )}
      {warnings.length === 0 ? null : (
        <ul className={styles.warnings}>
          {warnings.map((warning) => (
            <li key={warning}>
              <Banner variant="warning" title={warning} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
