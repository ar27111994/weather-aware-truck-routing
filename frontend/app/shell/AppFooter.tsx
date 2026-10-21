import type { ReactElement } from "react";

import { Link } from "../design-system/components/Link";
import { t } from "../design-system/foundation/strings";
import styles from "./AppFooter.module.css";

/**
 * The kitchen sink stays a public page (D-27) but is not in the header navigation, the sitemap or
 * the llms files; the footer is the one place the app links to it.
 */
const DESIGN_SYSTEM_PATH = "/design";

/**
 * Data attributions with their licences, the planning-aid disclaimer, the source link and the link
 * to the design system (DESIGN.md section 10, D-27). All wording and URLs come from the microcopy.
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
      <ul className={styles.links}>
        <li>
          <Link href={t("footer.sourceUrl")} isExternal>
            {t("footer.source")}
          </Link>
        </li>
        <li>
          <Link href={DESIGN_SYSTEM_PATH}>{t("footer.designSystem")}</Link>
        </li>
      </ul>
    </footer>
  );
}
