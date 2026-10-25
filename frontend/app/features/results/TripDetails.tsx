import { useId, type ReactElement } from "react";
import { useLocale } from "react-aria";

import type { Plan, Route } from "../../api/contract";
import { KeyValue } from "../../design-system/components/KeyValue";
import { Stack } from "../../design-system/components/Layout";
import { t } from "../../design-system/foundation/strings";
import { formatPounds } from "../../lib/format";
import { RISK_RULES } from "../../lib/risk";
import { departureClock } from "./route-format";
import styles from "./TripDetails.module.css";

/**
 * The facts of the trip behind the results (DESIGN.md section 10, "Trip details"): when the truck
 * leaves, the load and the gross weight routing used, the checkpoint spacing and count, the data
 * sources with their attribution, the plan id and how long the shared link works.
 */
export function TripDetails({
  plan,
  route,
}: {
  readonly plan: Plan;
  readonly route: Route;
}): ReactElement {
  const sourcesId = useId();
  const { locale } = useLocale();
  const { load_weight_lb: load, sampling_interval_mi: interval } = plan.request;
  const expires = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
    new Date(plan.expires_at),
  );
  return (
    <Stack gap={4}>
      <KeyValue
        layout="inline"
        entries={[
          { label: t("details.departure"), value: departureClock(route, locale) },
          { label: t("details.load"), value: formatPounds(load, { locale }) },
          {
            label: t("details.gross"),
            value: formatPounds(load + RISK_RULES.assumed_tare_lb, { locale }),
          },
          { label: t("details.interval"), value: t("form.interval.option", { n: interval }) },
          { label: t("details.checkpoints"), value: String(route.checkpoints.length) },
          { label: t("details.planId"), value: plan.plan_id },
        ]}
      />
      <section aria-labelledby={sourcesId}>
        <h3 id={sourcesId} className={styles.heading}>
          {t("details.sources")}
        </h3>
        <ul className={styles.sources}>
          {plan.sources.attribution.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
      <p className={styles.expires}>{t("details.expires", { date: expires })}</p>
    </Stack>
  );
}
