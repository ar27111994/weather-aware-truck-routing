import type { ReactElement } from "react";
import { useSearchParams } from "react-router";
import type { MetaDescriptor } from "react-router";

import { collectSections, selectSections } from "../design-system/demo-registry";
import type { DemoModule } from "../design-system/demo-registry";
import { t } from "../design-system/foundation/strings";
import { KitchenSink } from "../design-system/KitchenSink";
import { pageMeta } from "../shell/page-meta";

/*
 * Every `<Name>.demo.tsx` under components/ is a section of this page, so adding a component adds its
 * specimens here, to the visual goldens and to the axe run without touching this file. The glob is
 * lazy: every demo is a chunk of its own, loaded when its section is on the page, so the page
 * fills in section by section, and `?section=Name` loads only the sections it names (D-35).
 */
const SECTIONS = collectSections(
  import.meta.glob<DemoModule>("../design-system/components/*/*.demo.tsx"),
);

/** The kitchen sink is a working tool, not a page for search: noindex, and not in the sitemap. */
export function meta(): MetaDescriptor[] {
  return pageMeta({
    title: t("design.title"),
    description: t("design.description"),
    noindex: true,
  });
}

/** `/design`: the kitchen sink. `/design?section=Button&section=Card` shows those two only. */
export default function Design(): ReactElement {
  const [searchParams] = useSearchParams();
  return <KitchenSink {...selectSections(SECTIONS, searchParams.getAll("section"))} />;
}
