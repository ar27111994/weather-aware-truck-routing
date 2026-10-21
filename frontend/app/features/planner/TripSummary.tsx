import type { ReactElement } from "react";
import { useLocale } from "react-aria";

import type { Plan } from "../../api/contract";
import { Button } from "../../design-system/components/Button";
import { CopyButton } from "../../design-system/components/CopyButton";
import { Inline } from "../../design-system/components/Layout";
import { t } from "../../design-system/foundation/strings";
import { at } from "../../lib/checked";
import { departureClock } from "../results/route-format";
import styles from "./TripSummary.module.css";

/** Props for {@link TripSummary}. */
export interface TripSummaryProps {
  readonly plan: Plan;
  /** Opens the form again. */
  readonly onEdit: () => void;
  /** The address that restores this plan: what Copy link puts on the clipboard. */
  readonly link: string;
}

/**
 * The form after results (DESIGN.md section 10): one line saying what was planned, with Edit trip to
 * open the form again and Copy link to share the plan (R9).
 */
export function TripSummary({ plan, onEdit, link }: TripSummaryProps): ReactElement {
  const { locale } = useLocale();
  const { request } = plan;
  const line = t("form.summary", {
    origin: request.origin.label,
    destination: request.destination.label,
    departure: departureClock(at(plan.routes, 0), locale),
    load: request.load_weight_lb.toLocaleString(locale),
    interval: request.sampling_interval_mi,
  });
  return (
    <div className={styles.summary}>
      <p className={styles.line}>{line}</p>
      <Inline gap={2} wrap>
        <Button variant="secondary" size="sm" onPress={onEdit}>
          {t("form.edit")}
        </Button>
        <CopyButton
          text={link}
          size="sm"
          successMessage={t("app.copyLinkDone")}
          failureMessage={t("app.copyLinkFailed")}
        >
          {t("app.copyLink")}
        </CopyButton>
      </Inline>
    </div>
  );
}
