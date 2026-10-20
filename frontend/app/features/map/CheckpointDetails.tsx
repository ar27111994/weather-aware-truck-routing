import { X } from "lucide-react";
import type { ReactElement } from "react";

import { Badge } from "../../design-system/components/Badge";
import { Divider } from "../../design-system/components/Divider";
import { IconButton } from "../../design-system/components/IconButton";
import { t } from "../../design-system/foundation/strings";
import styles from "./CheckpointDetails.module.css";
import type { CheckpointDetailsModel } from "./checkpoint-details";

export interface CheckpointDetailsProps {
  readonly details: CheckpointDetailsModel;
  readonly onClose: () => void;
}

/** The content of the checkpoint popover (DESIGN.md section 9.7). */
export function CheckpointDetails({ details, onClose }: CheckpointDetailsProps): ReactElement {
  return (
    <div className={styles.details}>
      <div className={styles.header}>
        <Badge level={details.level} variant="solid" />
        <span className={styles.plate} aria-hidden="true">
          {details.routeId}
        </span>
        <h2 className={styles.title}>{details.title}</h2>
        <IconButton
          icon={X}
          label={t("popover.close")}
          onPress={onClose}
          className={styles.close}
        />
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>{t("popover.eta")}</dt>
          <dd>
            <span className={styles.data}>
              {details.eta} {details.offset}
            </span>
            <span className={styles.secondary}>{details.afterDeparture}</span>
          </dd>
        </div>
        <div>
          <dt>{t("popover.distance")}</dt>
          <dd className={styles.data}>{details.distance}</dd>
        </div>
      </dl>
      <Divider />
      <table className={styles.factors}>
        <thead>
          <tr>
            <th scope="col">{t("popover.factor")}</th>
            <th scope="col">{t("popover.value")}</th>
            <th scope="col">{t("popover.level")}</th>
          </tr>
        </thead>
        <tbody>
          {details.rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              <td className={styles.data}>{row.value}</td>
              <td>
                {row.level === undefined ? (
                  <span className={styles.note}>{row.note}</span>
                ) : (
                  <Badge level={row.level} variant="subtle" />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Divider />
      <dl className={styles.facts}>
        <div>
          <dt>{t("popover.loadRule")}</dt>
          <dd>{details.loadRule}</dd>
        </div>
        <div>
          <dt>{t("popover.why")}</dt>
          <dd>
            <ul className={styles.reasons}>
              {details.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>{t("popover.data")}</dt>
          <dd className={styles.secondary}>
            {details.validFor}
            {details.incomplete === null ? null : ` ${details.incomplete}`}
          </dd>
        </div>
      </dl>
    </div>
  );
}
