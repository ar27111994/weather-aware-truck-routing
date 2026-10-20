import type { ReactElement } from "react";
import { useLocation } from "react-router";

import { Link } from "../design-system/components/Link";
import { ThemeToggle } from "../design-system/components/ThemeToggle";
import { t } from "../design-system/foundation/strings";
import { useTheme } from "../design-system/foundation/ThemeProvider";
import styles from "./AppHeader.module.css";

/** `/methodology/` and `/methodology` are the same page. */
function normalise(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

/**
 * The 56 px header (DESIGN.md section 10): wordmark, primary navigation with the current page
 * marked, and the theme toggle. On narrow screens only the other page's link is shown, as in the
 * wireframes, so everything keeps its 44 px target.
 */
export function AppHeader(): ReactElement {
  const { theme, setTheme } = useTheme();
  const current = normalise(useLocation().pathname);
  const items = [
    { href: "/", label: t("app.nav.planner") },
    { href: "/methodology", label: t("app.nav.methodology") },
  ];
  return (
    <header className={styles.header}>
      <Link href="/" className={styles.wordmark} aria-label={t("app.name")}>
        HAUL<span className={styles.light}>CAST</span>
      </Link>
      <nav aria-label={t("app.nav.label")} className={styles.nav}>
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            variant="nav"
            {...(current === item.href ? { "aria-current": "page" as const } : {})}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <ThemeToggle value={theme} onChange={setTheme} className={styles.themeToggle} />
    </header>
  );
}
