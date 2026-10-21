import type { ReactElement } from "react";

import type { Plan } from "../../api/contract";
import type { ApiError } from "../../api/errors";
import { Button } from "../../design-system/components/Button";
import { EmptyState } from "../../design-system/components/EmptyState";
import { ErrorState, useRetryCountdown } from "../../design-system/components/ErrorState";
import { Card } from "../../design-system/components/Card";
import { Skeleton } from "../../design-system/components/Skeleton";
import { Stack } from "../../design-system/components/Layout";
import { Tab, TabList, TabPanel, Tabs } from "../../design-system/components/Tabs";
import { t, tList } from "../../design-system/foundation/strings";
import { at } from "../../lib/checked";
import { useSelectedRouteId } from "../../state";
import { CheckpointTable } from "./CheckpointTable";
import { RecommendationSummary } from "./RecommendationSummary";
import { RiskProfileChart } from "./RiskProfileChart";
import { RouteList } from "./RouteList";
import styles from "./ResultsPanel.module.css";
import { TripDetails } from "./TripDetails";

/** What the results area shows: nothing yet, a request in flight, a failure, or a plan. */
export type ResultsView =
  | { readonly kind: "empty"; readonly onTryScenario: () => void }
  | { readonly kind: "loading" }
  | {
      readonly kind: "error";
      readonly error: ApiError;
      /** The checkpoint interval of the request that failed (the too-many-checkpoints copy names it). */
      readonly interval: number;
      readonly onRetry: () => void;
      readonly onEdit: () => void;
    }
  | { readonly kind: "plan"; readonly plan: Plan };

function Loading(): ReactElement {
  return (
    <Stack gap={3} aria-busy="true">
      {[0, 1, 2].map((position) => (
        <Card key={position}>
          <Stack gap={3}>
            <Skeleton width="half" height="title" />
            <Skeleton width="three-quarters" />
            <Skeleton width="full" height="bar" />
            <Skeleton width="third" />
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}

function Failure({
  error,
  interval,
  onRetry,
  onEdit,
}: {
  readonly error: ApiError;
  readonly interval: number;
  readonly onRetry: () => void;
  readonly onEdit: () => void;
}): ReactElement {
  const waiting = error.retryAfterS ?? undefined;
  const remaining = useRetryCountdown(waiting);
  return (
    <ErrorState
      code={error.code}
      values={{
        seconds: remaining,
        minutes: Math.max(1, Math.ceil((waiting ?? 0) / 60)),
        interval,
      }}
      onEdit={onEdit}
      {...(error.retryable ? { onRetry } : {})}
      {...(error.requestId === null ? {} : { requestId: error.requestId })}
      {...(waiting === undefined ? {} : { retryAfterSeconds: remaining })}
    />
  );
}

function Results({ plan }: { readonly plan: Plan }): ReactElement {
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

/**
 * Everything under the trip form: the empty state before a plan, skeleton cards while one is being
 * made, the failure panel with its retry, and for a plan the recommendation, the route cards and
 * the tabs for the selected route (checkpoint table, risk profile, trip details).
 */
export function ResultsPanel({ view }: { readonly view: ResultsView }): ReactElement {
  switch (view.kind) {
    case "empty":
      return (
        <EmptyState
          title={t("empty.title")}
          steps={tList("empty.steps")}
          stepsLabel={t("empty.stepsLabel")}
          action={
            <Button variant="ghost" onPress={view.onTryScenario}>
              {t("empty.tryScenario")}
            </Button>
          }
        >
          {t("empty.body")}
        </EmptyState>
      );
    case "loading":
      return <Loading />;
    case "error":
      return (
        <Failure
          error={view.error}
          interval={view.interval}
          onRetry={view.onRetry}
          onEdit={view.onEdit}
        />
      );
    case "plan":
      return <Results plan={view.plan} />;
  }
}
