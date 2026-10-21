import type { ReactElement } from "react";

import type { Plan } from "../../api/contract";
import { t } from "../../design-system/foundation/strings";
import styles from "./MapRegion.module.css";
import type { RequestState } from "./PlanProgress";

/** Props for {@link MapRegion}. */
export interface MapRegionProps {
  /** The plan on show, or `null` before there is one. */
  readonly plan: Plan | null;
  /** Where the corridor forecast stands (`idle` until a plan exists). */
  readonly heatmapState: RequestState;
}

/**
 * The map's place in the page. The planner page owns the room the map takes (full bleed under the
 * sheet on a phone, beside the panel on a desktop) and what feeds it; the map itself (routes, risk
 * ribbons, markers, the heatmap and its timeline) is drawn by the map card's `MapView`, which the
 * integration card swaps in for this component with the same two props. Until then the room shows
 * its loading caption on the sunken surface, so the layout around it is the final one.
 */
export function MapRegion({ plan, heatmapState }: MapRegionProps): ReactElement {
  return (
    <section
      aria-label={t("app.regions.map")}
      className={styles.map}
      data-plan={plan === null ? "none" : plan.plan_id}
      data-heatmap={heatmapState}
    >
      <p className={styles.caption}>{t("empty.mapLoading")}</p>
    </section>
  );
}
