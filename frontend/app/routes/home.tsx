import type { ReactElement } from "react";
import type { MetaDescriptor } from "react-router";

import { t } from "../design-system/foundation/strings";
import { Page } from "../shell/Page";
import { pageMeta } from "../shell/page-meta";

/** Title, description, canonical and social tags for `/` (the pages card fills the page itself). */
export function meta(): MetaDescriptor[] {
  return pageMeta({ title: t("app.title"), description: t("app.description"), path: "/" });
}

/** Placeholder planner page: the planner and the map replace it in the feature cards. */
export default function Home(): ReactElement {
  return (
    <Page>
      <h1>{t("app.name")}</h1>
      <p>{t("empty.title")}</p>
      <p>{t("empty.body")}</p>
    </Page>
  );
}
