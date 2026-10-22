import { lazy, Suspense, type ReactElement } from "react";

import { plannerMayLoad } from "./intent";
import { pageContext } from "./page-gate";

/**
 * The planner's code (the form with its date, time, number and list controls, the schema library
 * and the query cache behind it) is a separate download that starts when the visitor first gives
 * the page an input, not when the page loads (N1, ADR 0007). The loader reads the page when React
 * first renders this component, which on the prerendered page is the hydration: that is where the
 * prerendered planner is in the document and the address says whether the visitor came with a trip.
 */
const PlannerApp = lazy(() => plannerMayLoad(pageContext()).then(() => import("./PlannerApp")));

/**
 * The planner as the route draws it. While its code is on the way the browser keeps the prerendered
 * form as it is (React does not hydrate a boundary whose code has not arrived), so there is no
 * fallback to show: a visit that reaches this page by navigating inside the app is not held
 * back and is drawn in the same transition.
 */
export function PlannerIsland(): ReactElement {
  return (
    <Suspense fallback={null}>
      <PlannerApp />
    </Suspense>
  );
}
