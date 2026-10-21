import type { ReactElement } from "react";
import { Group } from "react-aria-components";

import type { RiskRules } from "../../api/contract";
import { Badge } from "../../design-system/components/Badge";
import { VisuallyHidden } from "../../design-system/components/VisuallyHidden";
import { t } from "../../design-system/foundation/strings";
import { at } from "../../lib/checked";
import styles from "./RiskTable.module.css";
import { riskTableRows } from "./rules-text";

/**
 * The risk thresholds (R11): one row per weather factor, one column per level, every cell read off
 * the rules file, so a change to that file is a change to this table. The level names carry their
 * shape as well as their word. The region scrolls on a narrow screen instead of clipping.
 */
export function RiskTable({ rules }: { readonly rules: RiskRules }): ReactElement {
  const rows = riskTableRows(rules);
  const levels = at(rows, 0).cells.map((cell) => cell.level);
  return (
    <Group
      role="region"
      aria-label={t("methodology.rules.caption")}
      tabIndex={0}
      className={styles.scroll}
    >
      <table className={styles.table}>
        <caption>
          <VisuallyHidden>{t("methodology.rules.caption")}</VisuallyHidden>
        </caption>
        <thead>
          <tr>
            <th scope="col" className={styles.column}>
              {t("methodology.tableCols.condition")}
            </th>
            {levels.map((level) => (
              <th key={level} scope="col" className={styles.column}>
                <Badge level={level} variant="subtle" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.factor}>
              <th scope="row" className={styles.rowName}>
                {row.name}
              </th>
              {row.cells.map((cell) => (
                <td key={cell.level} className={styles.cell}>
                  {cell.text}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Group>
  );
}
