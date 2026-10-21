import type { ReactElement } from "react";
import type { MetaDescriptor } from "react-router";

import { t } from "../design-system/foundation/strings";
import { MethodologyPage } from "../features/methodology/MethodologyPage";
import { SITE_URL, pageMeta } from "../shell/page-meta";
import { faqPageLd, techArticleLd } from "../features/seo/structured-data";

/** Title, description, canonical and social tags for `/methodology`, with its structured data. */
export function meta(): MetaDescriptor[] {
  return [
    ...pageMeta({
      title: t("methodology.title"),
      description: t("methodology.lead"),
      path: "/methodology",
    }),
    { "script:ld+json": techArticleLd(SITE_URL) },
    { "script:ld+json": faqPageLd() },
  ];
}

/** How Haulcast scores weather risk: the rules, the reasons and the limits. */
export default function Methodology(): ReactElement {
  return <MethodologyPage />;
}
