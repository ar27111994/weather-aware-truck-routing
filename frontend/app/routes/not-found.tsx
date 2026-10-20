import type { MetaDescriptor } from "react-router";

import { t } from "../design-system/foundation/strings";
import { NotFoundPage } from "../shell/RouteError";
import { pageMeta } from "../shell/page-meta";

/** Not-found pages stay out of search results. */
export function meta(): MetaDescriptor[] {
  return pageMeta({
    title: t("notFound.title"),
    description: t("notFound.body"),
    path: "/404",
    noindex: true,
  });
}

/** The `*` route: any address that matches no page. */
export default NotFoundPage;
