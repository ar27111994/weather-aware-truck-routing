import type { ReactElement } from "react";

import { Link } from "../design-system/components/Link";
import { t } from "../design-system/foundation/strings";
import styles from "./AppFooter.module.css";

/**
 * Data attributions with their licences, the planning-aid disclaimer and the source link
 * (DESIGN.md section 10). All wording and URLs come from the microcopy.
 */
export function AppFooter(): ReactElement {
  const sources = [
    { href: t("footer.osmUrl"), label: t("footer.osm") },
    { href: t("footer.openfreemapUrl"), label: t("footer.openfreemap") },
    { href: t("footer.openmeteoUrl"), label: t("footer.openmeteo") },
  ];
  return (
    <footer className={styles.footer}>
      <ul className={styles.sources}>
        {sources.map((source) => (
          <li key={source.href}>
            <Link href={source.href} isExternal>
              {source.label}
            </Link>
          </li>
        ))}
      </ul>
      <p className={styles.disclaimer}>{t("footer.disclaimer")}</p>
      <p className={styles.source}>
        <Link href={t("footer.sourceUrl")} isExternal>
          {t("footer.source")}
        </Link>
      </p>
    </footer>
  );
}
