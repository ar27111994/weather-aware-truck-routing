import { useMemo } from "react";
import {
  createPath,
  useLocation,
  useNavigate,
  type NavigateFunction,
  type Navigator,
} from "react-router";

import type { PlannerBridge } from "./PlannerApp";

/**
 * A router's `navigate`, as the low-level router of the planner's own React root wants it: the
 * planner changes the address (it puts a plan in it) through the page's router, so the page's
 * history, its scroll and its Back button all see what the planner did.
 *
 * @param navigate - The page router's `navigate`.
 */
export function navigatorFor(navigate: NavigateFunction): Navigator {
  return {
    createHref: (to) => (typeof to === "string" ? to : createPath(to)),
    go: (delta) => {
      void navigate(delta);
    },
    push: (to, state: unknown, options) => {
      void navigate(to, { ...options, state });
    },
    replace: (to, state: unknown, options) => {
      void navigate(to, { ...options, state, replace: true });
    },
  };
}

/**
 * The page's address and its way of changing it, for the planner's own React root. It changes when
 * the page's address does, and not otherwise.
 */
export function usePlannerBridge(): PlannerBridge {
  const location = useLocation();
  const navigate = useNavigate();
  const navigator = useMemo(() => navigatorFor(navigate), [navigate]);
  return useMemo(() => ({ location, navigator }), [location, navigator]);
}
