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
import type { RouteHandle } from "./route-handle";

/** An address that leaves the app: any URL scheme (`https:`, `mailto:`, `tel:`) or a `//host` reference. */
const EXTERNAL_ADDRESS = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

/**
 * Every React Aria link resolves its `href` through this hook. React Router's `useHref` reads its
 * argument as an app path, so on its own it would turn `https://example.com` into
 * `/https:/example.com` and break every external link. External addresses are handed back as
 * written; app paths still resolve against the router.
 */
function useRouterHref(href: string): string {
  const resolved = useHref(href);
  return EXTERNAL_ADDRESS.test(href) ? href : resolved;
}

/**
 * The frame around every page: skip link first, then the header, the one `main` landmark and the
 * footer. React Aria's links are routed through React Router so internal navigation never reloads
 * the page, while external addresses stay exactly as written. A route can change the skip target
 * or take over the footer through its `handle`; a caller that must draw the same shell whatever
 * route matched (the loading fallback) passes its own `handle` and the routes' are ignored.
 */
export function AppShell({
  children,
  handle: given,
}: {
  readonly children: ReactNode;
  readonly handle?: RouteHandle;
}): ReactElement {
  const navigate = useNavigate();
  // React Router's navigate returns a promise and React Aria expects nothing back; no caller waits
  // for a navigation, so the promise is deliberately dropped here, in the one place that bridges them.
  const routerNavigate = useCallback(
    (path: string) => {
      void navigate(path);
    },
    [navigate],
  );
  const matched = useRouteHandle();
  const handle = given ?? matched;
  const skip = handle.skipLink ?? { href: "#main", label: "app.skipToMain" as const };
  return (
    <RouterProvider navigate={routerNavigate} useHref={useRouterHref}>
      <div className={styles.shell}>
        <SkipLink href={skip.href}>{t(skip.label)}</SkipLink>
        <AppHeader />
        <main id="main" tabIndex={-1} className={styles.main}>
          {children}
        </main>
        {handle.footer === false ? null : <AppFooter />}
      </div>
    </RouterProvider>
  );
}
