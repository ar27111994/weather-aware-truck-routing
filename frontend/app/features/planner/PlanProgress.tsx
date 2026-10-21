import { useEffect, useState, type ReactElement } from "react";

import {
  ProgressSteps,
  type ProgressStatus,
  type ProgressStepItem,
} from "../../design-system/components/ProgressSteps";
import { t, tList } from "../../design-system/foundation/strings";

/** The state of one real request: not started, in flight, answered, or failed. */
export type RequestState = "idle" | "loading" | "ready" | "error";

/** Props for {@link PlanProgress}. */
export interface PlanProgressProps {
  /** `POST /plans`: routing, weather and scoring all happen inside it. */
  readonly plan: RequestState;
  /** `GET /plans/{id}/heatmap`: the corridor forecast, asked for once the plan exists. */
  readonly heatmap: RequestState;
}

const STATUS: Readonly<Record<RequestState, ProgressStatus>> = {
  idle: "pending",
  loading: "active",
  ready: "done",
  error: "failed",
};

/** Whole seconds since the first render while `running`: the one clock the active step shows. */
function useElapsedSeconds(running: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    const started = performance.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((performance.now() - started) / 1000));
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [running]);
  return elapsed;
}

/**
 * The honest progress list (D-12): the plan request is one grouped step, because routing, weather
 * and scoring run together on the server; then the real corridor forecast request; then the
 * timeline, which is ready when the forecast frames are. Each status is read off a request, never
 * off a timer, and the only clock is the elapsed time of the step that is running.
 */
export function PlanProgress({ plan, heatmap }: PlanProgressProps): ReactElement {
  const serverRunning = plan === "loading";
  const elapsed = useElapsedSeconds(serverRunning);
  const afterPlan = plan === "ready";
  const steps: readonly ProgressStepItem[] = [
    {
      id: "server",
      label: t("progress.server"),
      status: STATUS[plan],
      details: tList("progress.serverSub"),
      ...(serverRunning ? { elapsedSeconds: elapsed } : {}),
    },
    {
      id: "heatmap",
      label: t("progress.heatmap"),
      status: afterPlan ? STATUS[heatmap] : "pending",
    },
    {
      id: "timeline",
      label: t("progress.timeline"),
      status: heatmap === "ready" ? "done" : "pending",
    },
  ];
  return <ProgressSteps label={t("progress.label")} steps={steps} />;
}
