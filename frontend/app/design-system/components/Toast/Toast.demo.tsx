import type { Demo } from "../../foundation/demo";
import { t } from "../../foundation/strings";
import { Button } from "../Button";
import { toast, ToastRegion } from "./Toast";

/** The planner's retry would go here; the demo only needs the action to be pressable. */
function noop(): void {
  return undefined;
}

function showSuccess(): void {
  toast.success(t("app.copyLinkDone"));
}

function showErrorWithAction(): void {
  toast.error(t("app.copyLinkFailed"), {
    action: { label: t("error.retry"), onAction: noop },
  });
}

function showInfo(): void {
  toast.info(t("app.copyLinkDone"));
}

/**
 * What the `/design` route renders for Toast. A toast only exists after a press, so each state is
 * the trigger; the region that shows them is mounted once, in the last state.
 */
export const demo: Demo = {
  name: "Toast",
  description: "Queued, auto-dismissing notifications in a live region.",
  states: [
    {
      id: "success",
      title: "Success: dismisses after 5 s",
      node: <Button onPress={showSuccess}>Show success toast</Button>,
    },
    {
      id: "error",
      title: "Error with an action: stays until closed",
      node: <Button onPress={showErrorWithAction}>Show error toast</Button>,
    },
    {
      id: "info",
      title: "Info: dismisses after 5 s",
      node: <Button onPress={showInfo}>Show info toast</Button>,
    },
    {
      id: "region",
      title: "The region that shows the queue (mount it once per app)",
      node: <ToastRegion closeLabel={t("toast.close")} />,
    },
  ],
};
