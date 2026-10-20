import type { ReactElement } from "react";
import type { MetaDescriptor } from "react-router";

import { collectDemos } from "../design-system/demo-registry";
import type { DemoModule } from "../design-system/demo-registry";
import { KitchenSink } from "../design-system/KitchenSink";
import { pageMeta } from "../shell/page-meta";

/*
 * Every `<Name>.demo.tsx` under components/ is picked up here, so adding a component adds its
 * specimens to this page, the visual goldens and the axe run without touching this file.
 */
const DEMOS = collectDemos(
  import.meta.glob<DemoModule>("../design-system/components/*/*.demo.tsx", { eager: true }),
);

/** The kitchen sink is a working tool, not a page for search: noindex, and not in the sitemap. */
export function meta(): MetaDescriptor[] {
  return pageMeta({
    title: "Design system",
    description: "Every Haulcast component in every state.",
    noindex: true,
  });
}

/** `/design`: the kitchen sink. */
export default function Design(): ReactElement {
  return <KitchenSink demos={DEMOS} />;
}
