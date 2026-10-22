import { lazy, Suspense, type ReactElement } from "react";

import type { Plan } from "../../api/contract";
import type { ApiError } from "../../api/errors";
import { Button } from "../../design-system/components/Button";
import { EmptyState } from "../../design-system/components/EmptyState";
import { ErrorState, useRetryCountdown } from "../../design-system/components/ErrorState";
import { Card } from "../../design-system/components/Card";
import { Skeleton } from "../../design-system/components/Skeleton";
import { Stack } from "../../design-system/components/Layout";
import { t, tList } from "../../design-system/foundation/strings";

/** The plan view loads on demand: it is the table, the tabs and the chart, and no visitor needs them before a plan exists (N1). */
const PlanResults = lazy(() => import("./PlanResults"));

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
      // The skeleton cards stand in while the plan view's code arrives, so the panel never blinks empty.
      return (
        <Suspense fallback={<Loading />}>
          <PlanResults plan={view.plan} />
        </Suspense>
      );
  }
}
