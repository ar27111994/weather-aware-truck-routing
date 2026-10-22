import { getLocalTimeZone } from "@internationalized/date";
import { useMemo, useState, type ReactElement } from "react";

import { useScenarios } from "../../api/queries";
import { BottomSheet } from "../../design-system/components/BottomSheet";
import { ToastRegion } from "../../design-system/components/Toast";
import { VisuallyHidden } from "../../design-system/components/VisuallyHidden";
import { t, tPlural } from "../../design-system/foundation/strings";
import type { Clock } from "./departure";
import { createEarlyInputSource } from "./early-input";
import type { IntentGate } from "./intent";
import { MapRegion } from "./MapRegion";
import { pageGate } from "./page-gate";
import styles from "./PlannerPage.module.css";
import { PlannerPanel } from "./PlannerPanel";
import { useIsClient } from "./use-is-client";
import { usePlannerSession, type PlannerSession } from "./usePlannerSession";

/** What the live region says about the plan: planning, ready (or do not depart), forecast map ready. */
export function statusText(
  session: Pick<PlannerSession, "plan" | "planState" | "heatmapState">,
): string {
  const { plan, planState, heatmapState } = session;
  if (planState === "loading") return t("status.planning");
  if (plan === null) return "";
  const planned =
    plan.recommendation.status === "no_safe_route"
      ? t("status.noSafeRoute")
      : tPlural("status.planReady", plan.routes.length, { route: plan.recommendation.route_id });
  return heatmapState === "ready" ? `${planned} ${t("status.heatmapReady")}` : planned;
}

/** Props for {@link PlannerPage}. */
export interface PlannerPageProps {
  /**
   * What hears the visitor while the planner's code is on the way. It is the page's own gate unless
   * a test brings another, and `null` where nobody listens (the prerender).
   */
  readonly gate?: IntentGate | null;
}

/**
 * The planner page (R10): on a desktop (1024 px and up) the panel sits at the side, about 420 px
 * wide and scrolling, with the map beside it; below that the map fills the screen and the panel
 * rides in a bottom sheet with three snap points. One persistent live region says what the plan is
 * doing, so a screen reader hears each change once. The first heading is visually hidden: the map
 * and the panel have names of their own.
 *
 * The panel is one element on every screen (D-47): the bottom sheet, which the style sheet turns
 * into the side panel from 1024 px. It is drawn that way in the prerendered page, so the form in it
 * is never moved, rebuilt or re-parented: not when the planner's code arrives and takes the page
 * over, not when the browser's clock appears, not when the window is resized. What the visitor typed
 * or chose before the code arrived is still in the same fields afterwards (D-46).
 *
 * The page's gate marks this element `data-busy` while the visitor waits for the code (intent.ts); the
 * server did not draw that attribute, so the element says that it may differ.
 */
export function PlannerPage({ gate = pageGate }: PlannerPageProps): ReactElement {
  const session = usePlannerSession();
  // The panel below starts over when the address changes (its key), and a query that nobody watches
  // is cancelled. The list of scenarios is therefore watched from here too, so the page asks for it
  // once, not once for each panel the page has had.
  useScenarios();
  const isClient = useIsClient();
  const clock = useMemo<Clock | null>(
    () => (isClient ? { now: () => new Date(), timeZone: getLocalTimeZone() } : null),
    [isClient],
  );
  const [early] = useState(() => createEarlyInputSource(gate));
  return (
    <div className={styles.page} data-planner-island="" suppressHydrationWarning>
      <VisuallyHidden>
        <h1>{t("app.h1Planner")}</h1>
      </VisuallyHidden>
      <div role="status" aria-live="polite" className={styles.live}>
        <VisuallyHidden>{statusText(session)}</VisuallyHidden>
      </div>
      <div className={styles.layout}>
        <BottomSheet label={t("app.regions.planner")} panelOnWide>
          <PlannerPanel key={session.search} session={session} clock={clock} early={early} />
        </BottomSheet>
        <div className={styles.mapArea}>
          <MapRegion plan={session.plan} heatmapState={session.heatmapState} />
        </div>
      </div>
      <ToastRegion closeLabel={t("toast.close")} />
    </div>
  );
}
