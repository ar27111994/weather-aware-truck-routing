import type { ReactElement } from "react";
import type { MetaDescriptor } from "react-router";

import { t } from "../design-system/foundation/strings";
import { PlannerIsland } from "../features/planner/PlannerIsland";
import { webApplicationLd } from "../features/seo/structured-data";
import { SITE_URL, pageMeta } from "../shell/page-meta";
import type { RouteHandle } from "../shell/route-handle";

/**
 * The planner draws its own footer inside its panel, and the skip link goes to that panel
 * (DESIGN.md section 8.4).
 */
export const handle = {
  skipLink: { href: "#planner", label: "app.skipLink" },
  footer: false,
} satisfies RouteHandle;

/** Title, description, canonical and social tags for `/`, with the structured data of the app. */
export function meta(): MetaDescriptor[] {
  return [
    ...pageMeta({ title: t("app.title"), description: t("app.description"), path: "/" }),
    { "script:ld+json": webApplicationLd(SITE_URL) },
  ];
}

/** The planner: the trip form and its results beside (or under) the map. */
export default function Home(): ReactElement {
  return <PlannerIsland />;
}
