import type { ReactElement } from "react";
import { useLocale } from "react-aria";
import { GridList, GridListItem } from "react-aria-components";

import type { Plan, Route } from "../../api/contract";
import { Badge } from "../../design-system/components/Badge";
import { KeyValue } from "../../design-system/components/KeyValue";
import { StackedBar } from "../../design-system/components/StackedBar";
import { Stat } from "../../design-system/components/Stat";
import { t } from "../../design-system/foundation/strings";
import { formatDuration, formatMiles } from "../../lib/format";
import { useSelectedRouteId, useTripActions } from "../../state";
import { tradeoffText } from "./decided-by";
import { arrivalClock, averageRiskText, milesByLevel, routeCardLabel } from "./route-format";
import styles from "./RouteList.module.css";
import { selectedRouteId } from "./selection";

function RouteCardBody({
  route,
  plan,
  locale,
}: {
  readonly route: Route;
  readonly plan: Plan;
  readonly locale: string;
}): ReactElement {
  const [firstSentence] = plan.recommendation.rationale;
  const why = route.recommended
    ? [firstSentence, tradeoffText(plan)].filter(
        (line): line is string => line !== undefined && line !== null,
      )
    : [];
  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.plate} aria-hidden="true">
          {route.route_id}
        </span>
        <span className={styles.name}>{t("route.label", { route: route.route_id })}</span>
        {route.recommended ? <Badge variant="neutral">{t("rec.badge")}</Badge> : null}
      </div>
      <p className={styles.via} title={route.summary}>
        {route.summary}
      </p>
      <div className={styles.stats}>
        <Stat label={t("route.distance")} value={formatMiles(route.distance_mi)} />
        <Stat label={t("route.duration")} value={formatDuration(route.duration_s)} />
        <Stat label={t("route.arrival")} value={arrivalClock(route, locale)} />
      </div>
      <StackedBar miles={milesByLevel(route)} />
      <KeyValue
        layout="inline"
        entries={[
          { label: t("route.avgRisk"), value: averageRiskText(route) },
          { label: t("route.maxLevel"), value: <Badge level={route.stats.max_level} /> },
        ]}
      />
      {why.length === 0 ? null : (
        <div className={styles.why}>
          {why.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The route options in rank order, one card each (R8). The list is a single-selection grid list
 * tied to the shared trip state: pressing a card, or Space or Enter on a focused one, selects that
 * route for the map, the checkpoint table and the risk profile; the arrow keys move between cards.
 * Selection is drawn in ink whatever the route's risk, which the Highest level badge carries.
 */
export function RouteList({ plan }: { readonly plan: Plan }): ReactElement {
  const { locale } = useLocale();
  const selected = useSelectedRouteId();
  const { selectRoute } = useTripActions();
  return (
    <GridList
      aria-label={t("results.routes")}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={selected === null ? [] : [selected]}
      onSelectionChange={(selection) => {
        selectRoute(selectedRouteId(selection));
      }}
      className={styles.list}
    >
      {plan.routes.map((route) => (
        <GridListItem
          key={route.route_id}
          id={route.route_id}
          textValue={routeCardLabel(route)}
          aria-label={routeCardLabel(route)}
          className={styles.item}
        >
          <RouteCardBody route={route} plan={plan} locale={locale} />
        </GridListItem>
      ))}
    </GridList>
  );
}
