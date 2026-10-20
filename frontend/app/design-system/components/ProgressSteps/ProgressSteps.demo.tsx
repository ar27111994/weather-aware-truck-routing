import type { Demo } from "../../foundation/demo";
import { t, tList } from "../../foundation/strings";
import { ProgressSteps } from "./ProgressSteps";
import type { ProgressStepItem } from "./ProgressSteps";

const label = t("progress.label");

/* The planner's honest steps: one grouped step for the single POST /plans request, the real
   GET /heatmap request, and the client-side frame decode. */
const allPending: readonly ProgressStepItem[] = [
  { id: "server", label: t("progress.server"), status: "pending" },
  { id: "heatmap", label: t("progress.heatmap"), status: "pending" },
  { id: "timeline", label: t("progress.timeline"), status: "pending" },
];

const serverActive: readonly ProgressStepItem[] = [
  {
    id: "server",
    label: t("progress.server"),
    status: "active",
    details: tList("progress.serverSub"),
    elapsedSeconds: 12,
  },
  { id: "heatmap", label: t("progress.heatmap"), status: "pending" },
  { id: "timeline", label: t("progress.timeline"), status: "pending" },
];

const heatmapActive: readonly ProgressStepItem[] = [
  { id: "server", label: t("progress.server"), status: "done" },
  { id: "heatmap", label: t("progress.heatmap"), status: "active" },
  { id: "timeline", label: t("progress.timeline"), status: "pending" },
];

const allDone: readonly ProgressStepItem[] = [
  { id: "server", label: t("progress.server"), status: "done" },
  { id: "heatmap", label: t("progress.heatmap"), status: "done" },
  { id: "timeline", label: t("progress.timeline"), status: "done" },
];

const failed: readonly ProgressStepItem[] = [
  { id: "server", label: t("progress.server"), status: "done" },
  { id: "heatmap", label: t("progress.heatmap"), status: "failed" },
  { id: "timeline", label: t("progress.timeline"), status: "pending" },
];

export const demo: Demo = {
  name: "ProgressSteps",
  description:
    "Honest progress for the planner: steps map to real requests and the caller passes their status, so nothing is timed here.",
  states: [
    {
      id: "all-pending",
      title: "Nothing started",
      node: <ProgressSteps label={label} steps={allPending} />,
    },
    {
      id: "server-active",
      title: "Server request running: three stages, one elapsed readout",
      node: <ProgressSteps label={label} steps={serverActive} />,
    },
    {
      id: "heatmap-active",
      title: "Server done, forecast map loading",
      node: <ProgressSteps label={label} steps={heatmapActive} />,
    },
    {
      id: "all-done",
      title: "Everything done",
      node: <ProgressSteps label={label} steps={allDone} />,
    },
    {
      id: "failed",
      title: "A step failed",
      node: <ProgressSteps label={label} steps={failed} />,
    },
  ],
};
