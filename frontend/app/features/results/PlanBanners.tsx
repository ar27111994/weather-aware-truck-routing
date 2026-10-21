import type { ReactElement } from "react";

import type { Plan } from "../../api/contract";
import { Banner } from "../../design-system/components/Banner";
import { Button } from "../../design-system/components/Button";
import { Stack } from "../../design-system/components/Layout";
import { t, tPlural } from "../../design-system/foundation/strings";
import { at } from "../../lib/checked";
import { formatMiles } from "../../lib/format";

/** Props for {@link PlanBanners}. */
export interface PlanBannersProps {
  readonly plan: Plan;
  /** The scenario's display name; the scenario id is shown until the list of scenarios has loaded. */
  readonly scenarioName?: string | undefined;
  /** Called by the "Change departure" action of the no-safe-route banner. */
  readonly onChangeDeparture?: (() => void) | undefined;
}

/**
 * The notices that sit above the trip form (DESIGN.md section 7, content order 1 and 2): simulated
 * weather, the do-not-depart result, fewer routes than three, and checkpoints without weather.
 * Each one is drawn from the plan itself, so none can be left out of a plan that needs it.
 */
export function PlanBanners({
  plan,
  scenarioName,
  onChangeDeparture,
}: PlanBannersProps): ReactElement | null {
  const recommended = at(plan.routes, 0);
  const scenario = plan.sources.scenario;
  const unknownCheckpoints = recommended.checkpoints.filter(
    (checkpoint) => checkpoint.risk.level === null,
  ).length;
  const notices: ReactElement[] = [];
  if (scenario !== null) {
    notices.push(
      <Banner key="scenario" variant="scenario" title={t("banner.scenario.title")}>
        {t("banner.scenario.body", { name: scenarioName ?? scenario })}
      </Banner>,
    );
  }
  if (plan.recommendation.status === "no_safe_route") {
    notices.push(
      <Banner
        key="no-safe-route"
        variant="no-safe-route"
        title={t("banner.noSafeRoute.title")}
        action={
          onChangeDeparture === undefined ? undefined : (
            <Button variant="secondary" size="sm" onPress={onChangeDeparture}>
              {t("banner.noSafeRoute.action")}
            </Button>
          )
        }
      >
        {t("banner.noSafeRoute.body", {
          route: plan.recommendation.route_id,
          miles: formatMiles(recommended.stats.miles_by_level.no_travel, { unit: false }),
        })}
      </Banner>,
    );
  }
  if (plan.routes.length < 3) {
    notices.push(
      <Banner key="fewer-routes" variant="info" title={t("banner.fewerRoutes.title")}>
        {tPlural("route.fewerRoutes", plan.routes.length)}
      </Banner>,
    );
  }
  if (unknownCheckpoints > 0) {
    notices.push(
      <Banner key="partial-weather" variant="warning" title={t("banner.partialWeather.title")}>
        {tPlural("banner.partialWeather.summary", unknownCheckpoints)}
      </Banner>,
    );
  }
  return notices.length === 0 ? null : <Stack gap={3}>{notices}</Stack>;
}
