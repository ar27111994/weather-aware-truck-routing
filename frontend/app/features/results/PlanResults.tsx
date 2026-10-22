import type { ReactElement } from "react";

import type { Plan } from "../../api/contract";
import { Stack } from "../../design-system/components/Layout";
import { Tab, TabList, TabPanel, Tabs } from "../../design-system/components/Tabs";
import { t } from "../../design-system/foundation/strings";
import { at } from "../../lib/checked";
import { useSelectedRouteId } from "../../state";
import { CheckpointTable } from "./CheckpointTable";
import styles from "./PlanResults.module.css";
import { RecommendationSummary } from "./RecommendationSummary";
import { RiskProfileChart } from "./RiskProfileChart";
import { RouteList } from "./RouteList";
import { TripDetails } from "./TripDetails";

/**
 * What a plan shows: the recommendation, the route cards and the tabs for the selected route
 * (checkpoint table, risk profile, trip details). This is the heavy half of the results area (the
 * table, the tabs and the chart), so `ResultsPanel` loads it only once there is a plan: a visitor who
 * has not planned a trip never downloads it (N1).
 */
export default function PlanResults({ plan }: { readonly plan: Plan }): ReactElement {
  const selectedId = useSelectedRouteId();
  const selected = plan.routes.find((route) => route.route_id === selectedId) ?? at(plan.routes, 0);
  return (
    <Stack gap={6}>
      <RecommendationSummary plan={plan} />
      <section aria-labelledby="routes-heading" className={styles.routes}>
        <h2 id="routes-heading" className={styles.heading}>
          {t("results.routes")}
        </h2>
        <RouteList plan={plan} />
      </section>
      <Tabs>
        <TabList aria-label={t("tabs.label")}>
          <Tab id="checkpoints">{t("tabs.checkpoints")}</Tab>
          <Tab id="profile">{t("tabs.profile")}</Tab>
          <Tab id="details">{t("tabs.details")}</Tab>
        </TabList>
        <TabPanel id="checkpoints">
          <CheckpointTable route={selected} />
        </TabPanel>
        <TabPanel id="profile">
          <RiskProfileChart route={selected} />
        </TabPanel>
        <TabPanel id="details">
          <TripDetails plan={plan} route={selected} />
        </TabPanel>
      </Tabs>
    </Stack>
  );
}
