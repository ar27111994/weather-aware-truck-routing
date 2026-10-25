import { useEffect, useRef, useState, type ReactElement } from "react";
import { useLocale } from "react-aria";
import { useLocation } from "react-router";

import type { ApiError } from "../../api/errors";
import { useScenarios } from "../../api/queries";
import { Banner } from "../../design-system/components/Banner";
import { Button } from "../../design-system/components/Button";
import { Stack } from "../../design-system/components/Layout";
import { Spinner } from "../../design-system/components/Spinner";
import { t } from "../../design-system/foundation/strings";
import { AppFooter } from "../../shell/AppFooter";
import { PlanBanners } from "../results/PlanBanners";
import { ResultsPanel, type ResultsView } from "../results/ResultsPanel";
import type { Clock } from "./departure";
import { useEarlyInput, type EarlyInputSource } from "./early-input";
import { PlanProgress } from "./PlanProgress";
import { PlannerForm } from "./PlannerForm";
import styles from "./PlannerPanel.module.css";
import { planFailure } from "./server-errors";
import { TripSummary } from "./TripSummary";
import { usePlannerForm } from "./usePlannerForm";
import type { PlannerSession } from "./usePlannerSession";

/** Props for {@link PlannerPanel}. */
export interface PlannerPanelProps {
  readonly session: PlannerSession;
  /** The visitor's clock; `null` on the prerendered page. */
  readonly clock: Clock | null;
  /** What the visitor did to the prerendered page before the planner's code arrived (D-46). */
  readonly early: EarlyInputSource;
}

/**
 * Everything in the side panel or the bottom sheet, in the order the design gives (DESIGN.md section
 * 7): the notices, the trip form (or its one-line summary once there is a plan), the progress of the
 * requests, then the results or their empty, loading and error states, and the footer. The form
 * starts from the address, so give this component a `key` of the address: a new address (back, a
 * new plan) starts it over from what the address says. The address the page was opened on (a shared
 * link) is not a new address: the form fills from it where it stands (`usePlannerForm`).
 */
export function PlannerPanel({ session, clock, early }: PlannerPanelProps): ReactElement {
  const { plan, error, planState, heatmapState } = session;
  const form = usePlannerForm(session.inputs, clock);
  const scenarios = useScenarios();
  const location = useLocation();
  const root = useRef<HTMLDivElement>(null);
  const { locale } = useLocale();
  useEarlyInput(early, { root, form, ready: clock !== null, locale });
  const [editing, setEditing] = useState<boolean | undefined>(undefined);
  const [focusRequest, setFocusRequest] = useState(0);
  const [reported, setReported] = useState<ApiError | null>(null);
  const [refusals, setRefusals] = useState(0);

  // A failed plan request that blames fields marks them on the form, once per failure.
  const failure = error === null ? null : planFailure(error);
  if (error !== reported) {
    setReported(error);
    if (failure !== null && !failure.showsPanel) {
      form.showErrors(failure.fieldErrors);
      setRefusals((count) => count + 1);
    }
  }

  const showForm = editing ?? plan === null;
  // Edit trip, Change departure and the error panel's Edit trip all end with the keyboard in the form.
  useEffect(() => {
    if (focusRequest > 0) root.current?.querySelector<HTMLElement>("form input")?.focus();
  }, [focusRequest]);
  // A plan is longer than the form, and the sheet keeps the scroll position the form had (the
  // visitor scrolled down to Plan routes), so a plan that arrives is shown from its top. Left alone
  // the visitor lands in the middle of the results, or at the end of the table when the browser
  // keeps the footer where it was while the results load above it (scroll anchoring).
  const planId = plan?.plan_id;
  const { consumeFocusRequest } = session;
  useEffect(() => {
    if (planId === undefined) return;
    root.current?.scrollIntoView({ block: "start" });
    // The keyboard was on the button that made the plan, and that button left with the form (R4-10).
    if (consumeFocusRequest(planId)) root.current?.focus({ preventScroll: true });
  }, [planId, consumeFocusRequest]);
  const openForm = (): void => {
    setEditing(true);
    setFocusRequest((count) => count + 1);
  };

  const scenarioName = scenarios.data?.find(
    (scenario) => scenario.id === plan?.sources.scenario,
  )?.name;
  const view: ResultsView =
    planState === "loading"
      ? { kind: "loading" }
      : error !== null && failure?.showsPanel === true
        ? {
            kind: "error",
            error,
            interval: form.interval,
            onRetry: session.retry,
            onEdit: openForm,
          }
        : plan !== null
          ? { kind: "plan", plan }
          : {
              kind: "empty",
              onTryScenario: () => {
                const first = scenarios.data?.[0];
                if (first !== undefined) form.setScenario(first.id);
              },
            };
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <div ref={root} id="planner" tabIndex={-1} className={styles.panel} data-planner-panel="">
      <div className={styles.busy}>
        <Spinner label={t("progress.state.active")} size={20} />
      </div>
      <Stack gap={6}>
        {plan === null ? null : (
          <PlanBanners plan={plan} scenarioName={scenarioName} onChangeDeparture={openForm} />
        )}
        {showForm || plan === null ? (
          <PlannerForm
            form={form}
            clock={clock}
            isSubmitting={planState === "loading"}
            onSubmit={session.submit}
            refusals={refusals}
          />
        ) : (
          <TripSummary
            plan={plan}
            onEdit={openForm}
            link={`${origin}${location.pathname}${location.search}`}
          />
        )}
        {planState === "loading" ? <PlanProgress plan="loading" heatmap="idle" /> : null}
        {planState !== "loading" && plan !== null && heatmapState === "loading" ? (
          <PlanProgress plan="ready" heatmap="loading" />
        ) : null}
        {heatmapState === "error" ? (
          <Banner
            variant="warning"
            title={t("error.heatmap_failed.title")}
            action={
              <Button variant="secondary" size="sm" onPress={session.retryHeatmap}>
                {t("error.retry")}
              </Button>
            }
          >
            {t("error.heatmap_failed.body")}
          </Banner>
        ) : null}
        <ResultsPanel view={view} />
        <AppFooter />
      </Stack>
    </div>
  );
}
