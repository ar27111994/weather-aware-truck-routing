import { useMatches } from "react-router";

import type { StringKey } from "../design-system/foundation/strings";

/**
 * What a route can say about the page around it, through React Router's `handle` export:
 *
 * ```ts
 * export const handle = { skipLink: { href: "#planner", label: "app.skipLink" }, footer: false };
 * ```
 *
 * The app shell merges the handles of every matched route, deepest last.
 */
export interface RouteHandle {
  /** Where the skip link goes and what it says. Defaults to the main content. */
  readonly skipLink?: { readonly href: string; readonly label: StringKey };
  /** `false` when the page draws its own footer, as the planner does inside its panel. */
  readonly footer?: boolean;
}

function isRouteHandle(value: unknown): value is RouteHandle {
  return typeof value === "object" && value !== null;
}

/** The merged `handle` of the matched routes. */
export function useRouteHandle(): RouteHandle {
  return useMatches().reduce<RouteHandle>(
    (merged, match) => (isRouteHandle(match.handle) ? { ...merged, ...match.handle } : merged),
    {},
  );
}
