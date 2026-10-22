import { getLocalTimeZone } from "@internationalized/date";
import { useMemo, type ReactElement } from "react";

import { useScenarios } from "../../api/queries";
import { BottomSheet } from "../../design-system/components/BottomSheet";
import { Spinner } from "../../design-system/components/Spinner";
import { ToastRegion } from "../../design-system/components/Toast";
import { VisuallyHidden } from "../../design-system/components/VisuallyHidden";
import { t, tPlural } from "../../design-system/foundation/strings";
import { useMediaQuery } from "../../design-system/foundation/useMediaQuery";
import type { Clock } from "./departure";
import { MapRegion } from "./MapRegion";
import styles from "./PlannerPage.module.css";
import { PlannerPanel } from "./PlannerPanel";
import { useIsClient } from "./use-is-client";
import { usePlannerSession, type PlannerSession } from "./usePlannerSession";

/** The width from which the panel sits beside the map instead of in a sheet over it (DESIGN.md section 7). */
export const DESKTOP_QUERY = "(min-width: 1024px)";

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

/**
 * The planner page (R10): on a desktop (1024 px and up) the panel sits at the side, about 420 px
 * wide and scrolling, with the map beside it; below that the map fills the screen and the panel
 * rides in a bottom sheet with three snap points. One persistent live region says what the plan is
 * doing, so a screen reader hears each change once. The first heading is visually hidden: the map
 * and the panel have names of their own.
 *
 * The prerendered page and the first browser render always use the side layout, which the style
 * sheet turns into a plain, sheet-shaped panel on a narrow screen. Only after the browser has taken
 * over does a narrow screen swap in the real, draggable sheet. Both are fixed to the bottom edge, so
 * the swap moves nothing, and a wide screen never changes layout at all.
 */
export function PlannerPage(): ReactElement {
  const session = usePlannerSession();
  // The panel below starts over when the browser takes over (its key changes), and a query that
  // nobody watches is cancelled. The list of scenarios is therefore watched from here too, so the
  // page asks for it once, not once for the panel that is thrown away and once for its successor.
  useScenarios();
  const isClient = useIsClient();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const clock = useMemo<Clock | null>(
    () => (isClient ? { now: () => new Date(), timeZone: getLocalTimeZone() } : null),
    [isClient],
  );
  // The panel starts over from the address, and once the clock exists (the browser took over).
  const panel = (
    <PlannerPanel
      key={`${session.search}|${String(clock !== null)}`}
      session={session}
      clock={clock}
    />
  );
  const map = (
    <div className={styles.mapArea}>
      <MapRegion plan={session.plan} heatmapState={session.heatmapState} />
    </div>
  );
  const inSheet = isClient && !isDesktop;
  return (
    <div className={styles.page} data-planner-island="">
      <VisuallyHidden>
        <h1>{t("app.h1Planner")}</h1>
      </VisuallyHidden>
      <div role="status" aria-live="polite" className={styles.live}>
        <VisuallyHidden>{statusText(session)}</VisuallyHidden>
      </div>
      {inSheet ? (
        <>
          {map}
          <BottomSheet label={t("app.regions.planner")}>{panel}</BottomSheet>
        </>
      ) : (
        <div className={styles.layout}>
          <section
            aria-label={t("app.regions.planner")}
            className={styles.side}
            data-planner-panel=""
          >
            <div className={styles.busy}>
              <Spinner label={t("progress.state.active")} size={20} />
            </div>
            {panel}
          </section>
          {map}
        </div>
      )}
      <ToastRegion closeLabel={t("toast.close")} />
    </div>
  );
}
