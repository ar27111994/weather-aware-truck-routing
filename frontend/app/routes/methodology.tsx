import type { ReactElement } from "react";
import type { MetaDescriptor } from "react-router";

import { t } from "../design-system/foundation/strings";
import { Page } from "../shell/Page";
import { pageMeta } from "../shell/page-meta";

/** Title, description, canonical and social tags for `/methodology`. */
export function meta(): MetaDescriptor[] {
  return pageMeta({
    title: t("methodology.title"),
    description: t("methodology.lead"),
    path: "/methodology",
  });
}

/** Placeholder methodology page: the full write-up arrives with the pages card. */
export default function Methodology(): ReactElement {
  return (
    <Page>
      <h1>{t("methodology.title")}</h1>
      <p>{t("methodology.lead")}</p>
    </Page>
  );
}
