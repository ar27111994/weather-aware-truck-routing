import type { ReactElement } from "react";
import { isRouteErrorResponse, useRouteError } from "react-router";

import { Button } from "../design-system/components/Button";
import { Inline } from "../design-system/components/Layout";
import { Link } from "../design-system/components/Link";
import { t } from "../design-system/foundation/strings";
import { AppShell } from "./AppShell";
import { Page } from "./Page";

/** The page for an address that matches nothing (the `*` route, and a 404 thrown by a loader). */
export function NotFoundPage(): ReactElement {
  return (
    <Page>
      <h1>{t("notFound.title")}</h1>
      <p>{t("notFound.body")}</p>
      <Inline>
        <Link href="/">{t("notFound.action")}</Link>
      </Inline>
    </Page>
  );
}

/**
 * The root error boundary: a 404 response shows the not-found page, anything else the crash page
 * with a reload button. Both keep the header and footer so a visitor is never stranded.
 */
export function RouteError(): ReactElement {
  const error = useRouteError();
  const isNotFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <AppShell>
      {isNotFound ? (
        <NotFoundPage />
      ) : (
        <Page>
          <h1>{t("crash.title")}</h1>
          <p>{t("crash.body")}</p>
          <Inline gap={3} wrap>
            <Button
              variant="primary"
              onPress={() => {
                window.location.reload();
              }}
            >
              {t("error.retry")}
            </Button>
            <Link href="/">{t("notFound.action")}</Link>
          </Inline>
        </Page>
      )}
    </AppShell>
  );
}
