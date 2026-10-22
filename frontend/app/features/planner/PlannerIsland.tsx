import {
  lazy,
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { ISLAND_SELECTOR, plannerMayLoad } from "./intent";
import { pageContext } from "./page-gate";
import type { PlannerMount } from "./PlannerApp";
import styles from "./PlannerIsland.module.css";
import { usePlannerBridge } from "./planner-bridge";

/** The planner for a visit that arrives by navigating inside the app: drawn in this page's tree. */
const LivePlanner = lazy(() => import("./PlannerApp"));

/**
 * The planner as the server draws it. Only the server has it: the branch is cut from the browser's
 * bundle, so the code that draws the planner on the server never reaches a visitor.
 */
const serverMarkup: Promise<string> | null = import.meta.env.SSR
  ? import("./planner-markup").then(({ renderPlannerMarkup }) => renderPlannerMarkup())
  : null;

/** Whether the page the browser opened has the planner in it already, drawn by the server. */
function drawnByTheServer(): boolean {
  return import.meta.env.SSR || document.querySelector(ISLAND_SELECTOR) !== null;
}

/**
 * The planner the server drew, kept as it is until the visitor reaches for it (N1, the ADR in docs/adr/intent-gated-hydration-of-the-planner.md). The
 * page draws it as plain markup that nothing in the page reaches: React is never asked to keep it,
 * update it or hydrate it, so a theme that is applied late, a router that settles or any other
 * update of the page around it leaves it alone, however long the visitor takes. A boundary that
 * waits for its code does not survive that (React draws it again, empty, on its second update).
 *
 * When the visitor first gives the page an input, the planner's code is downloaded and takes the
 * markup over as a React root of its own, element for element (D-46, D-47). It follows the page's
 * address through the bridge, and is taken down with the page.
 */
function StaticPlanner(): ReactElement {
  const markup = serverMarkup === null ? "" : use(serverMarkup);
  const html = useMemo(() => ({ __html: markup }), [markup]);
  const bridge = usePlannerBridge();
  const planner = useRef<PlannerMount | null>(null);
  const latest = useRef(bridge);
  const [failure, setFailure] = useState<Error | null>(null);

  useEffect(() => {
    latest.current = bridge;
    planner.current?.update(bridge);
  }, [bridge]);

  // The page's element is given to React here and taken back when the page goes: the planner starts
  // when the visitor reaches for it, and a visit that is over by then starts nothing.
  const start = useCallback((host: HTMLDivElement): (() => void) => {
    let cancelled = false;
    plannerMayLoad(pageContext())
      .then(() => import("./PlannerApp"))
      .then(({ mountPlanner }) => {
        if (!cancelled) planner.current = mountPlanner(host, latest.current);
      })
      // A download that failed rejects: the route's error page says the planner did not load.
      .catch((error: unknown) => {
        if (!cancelled) setFailure(new Error("The planner's code did not load.", { cause: error }));
      });
    return () => {
      cancelled = true;
      const mounted = planner.current;
      planner.current = null;
      // A root cannot be taken down while React is still drawing the page that holds it.
      if (mounted !== null) {
        queueMicrotask(() => {
          mounted.unmount();
        });
      }
    };
  }, []);

  if (failure !== null) throw failure;
  return (
    <div
      ref={start}
      className={styles.host}
      data-planner-host=""
      suppressHydrationWarning
      dangerouslySetInnerHTML={html}
    />
  );
}

/**
 * The planner as the route draws it. A visit to the prerendered page keeps the server's planner
 * until the visitor reaches for it; a visit that arrives by navigating inside the app has no
 * server's planner to keep, and is not held back: it is drawn in the same transition, with no
 * fallback to show and no shift.
 */
export function PlannerIsland(): ReactElement {
  const [prerendered] = useState(drawnByTheServer);
  return prerendered ? (
    <StaticPlanner />
  ) : (
    <Suspense fallback={null}>
      <LivePlanner />
    </Suspense>
  );
}
