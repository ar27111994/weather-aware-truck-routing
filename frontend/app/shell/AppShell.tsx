import type { ReactElement, ReactNode } from "react";
import { useCallback } from "react";
import { RouterProvider } from "react-aria-components";
import { useHref, useNavigate } from "react-router";

import { SkipLink } from "../design-system/components/SkipLink";
import { t } from "../design-system/foundation/strings";
import { AppFooter } from "./AppFooter";
import { AppHeader } from "./AppHeader";
import styles from "./AppShell.module.css";
import { useRouteHandle } from "./route-handle";

/**
 * The frame around every page: skip link first, then the header, the one `main` landmark and the
 * footer. React Aria's links are routed through React Router so internal navigation never reloads
 * the page. A route can change the skip target or take over the footer through its `handle`.
 */
export function AppShell({ children }: { readonly children: ReactNode }): ReactElement {
  const navigate = useNavigate();
  // React Router's navigate returns a promise and React Aria expects nothing back; no caller waits
  // for a navigation, so the promise is deliberately dropped here, in the one place that bridges them.
  const routerNavigate = useCallback(
    (path: string) => {
      void navigate(path);
    },
    [navigate],
  );
  const handle = useRouteHandle();
  const skip = handle.skipLink ?? { href: "#main", label: "app.skipToMain" as const };
  return (
    <RouterProvider navigate={routerNavigate} useHref={useHref}>
      <div className={styles["shell"]}>
        <SkipLink href={skip.href}>{t(skip.label)}</SkipLink>
        <AppHeader />
        <main id="main" tabIndex={-1} className={styles["main"]}>
          {children}
        </main>
        {handle.footer === false ? null : <AppFooter />}
      </div>
    </RouterProvider>
  );
}
