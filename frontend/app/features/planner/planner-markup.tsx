import { renderToString } from "react-dom/server";

import { PlannerIslandTree } from "./PlannerApp";

/**
 * The planner as the prerender draws it: a page of its own, with no address and no visitor. It is
 * drawn as a React root of its own, not as part of the page around it, so the ids that React Aria
 * gives its fields come out the same as when the browser draws the planner as a root of its own and
 * takes this markup over. Only the server imports this module.
 */
export function renderPlannerMarkup(): string {
  return renderToString(<PlannerIslandTree bridge={null} />);
}
