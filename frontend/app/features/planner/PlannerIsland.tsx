import { use, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { ISLAND_SELECTOR, plannerMayLoad } from "./intent";
import { pageContext } from "./page-gate";
import type { PlannerMount } from "./PlannerApp";
import styles from "./PlannerIsland.module.css";
import { usePlannerBridge } from "./planner-bridge";
import { plannerShell } from "./planner-shell";

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

/** Props for {@link StaticPlanner}. */
interface StaticPlannerProps {
  /** The planner's drawing. Empty where the page already holds the server's. */
  readonly markup: string;
  /** Whether the planner's code waits for the visitor: it does on the prerendered page only. */
  readonly gated: boolean;
}

/**
 * The planner as a drawing that the page keeps as it is until the visitor reaches for it (N1, the
 * ADR in docs/adr/intent-gated-hydration-of-the-planner.md). The page draws it as plain markup that
 * nothing in the page reaches: React is never asked to keep it, update it or hydrate it, so a theme
 * that is applied late, a router that settles or any other update of the page around it leaves it
 * alone, however long the visitor takes. A boundary that waits for its code does not survive that
 * (React draws it again, empty, on its second update).
 *
 * When the visitor first gives the page an input, the planner's code is downloaded and takes the
 * markup over as a React root of its own, element for element (D-46, D-47). It follows the page's
 * address through the bridge, and is taken down with the page.
 */
function StaticPlanner({ markup, gated }: StaticPlannerProps): ReactElement {
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
  const start = useCallback(
    (host: HTMLDivElement): (() => void) => {
      let cancelled = false;
      plannerMayLoad({ ...pageContext(), island: gated })
        .then(() => import("./PlannerApp"))
        .then(({ mountPlanner }) => {
          if (cancelled) return;
          planner.current = mountPlanner(host, latest.current, (error) => {
            // The planner is a root of its own: the route's error page shows only if the page throws.
            if (!cancelled) setFailure(new Error("The planner stopped working.", { cause: error }));
          });
        })
        // A download that failed rejects: the route's error page says the planner did not load.
        .catch((error: unknown) => {
          if (!cancelled)
            setFailure(new Error("The planner's code did not load.", { cause: error }));
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
    },
    [gated],
  );

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
 * The planner as the route draws it. Both kinds of visit draw the planner as the prerender drew it,
 * and the planner's code takes that drawing over:
 *
 * - A visit to the prerendered page keeps the server's drawing until the visitor reaches for the
 *   planner.
 * - A visit that arrives by navigating inside the app has no server's drawing in its page. The
 *   drawing is read from the prerendered page, and the planner's code starts at once: arriving is
 *   the visitor's input. Until the drawing is read the router keeps the old page, because reading
 *   it suspends the transition that the router moves between pages in; there is no boundary here
 *   to show a fallback, and the page is never empty (R4-01, D-46 3.1). When it is read, the
 *   planner is on the page at once, with no shift, while its code is on the way.
 */
export function PlannerIsland(): ReactElement {
  const [prerendered] = useState(drawnByTheServer);
  const drawn = prerendered ? serverMarkup : plannerShell();
  return <StaticPlanner markup={drawn === null ? "" : use(drawn)} gated={prerendered} />;
}
