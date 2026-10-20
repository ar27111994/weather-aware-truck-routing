import { useMatches } from "react-router";

import { isStringKey } from "../design-system/foundation/strings";
import type { StringKey } from "../design-system/foundation/strings";

/**
 * What a route can say about the page around it, through React Router's `handle` export:
 *
 * ```ts
 * export const handle = {
 *   skipLink: { href: "#planner", label: "app.skipLink" },
 *   footer: false,
 * } satisfies RouteHandle;
 * ```
 *
 * The app shell merges the handles of every matched route, deepest last. `satisfies` has the
 * compiler check the literal; {@link readRouteHandle} checks it again at runtime, because React
 * Router hands the shell an `unknown`.
 */
export interface RouteHandle {
  /** Where the skip link goes and what it says. Defaults to the main content. */
  readonly skipLink?: { readonly href: string; readonly label: StringKey };
  /** `false` when the page draws its own footer, as the planner does inside its panel. */
  readonly footer?: boolean;
}

/** A value as a developer should see it in an error message. */
function shown(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function readSkipLink(value: unknown): NonNullable<RouteHandle["skipLink"]> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`Route handle: skipLink must be { href, label }, got ${shown(value)}.`);
  }
  const href = "href" in value ? value.href : undefined;
  if (typeof href !== "string") {
    throw new TypeError(`Route handle: skipLink.href must be text, got ${shown(href)}.`);
  }
  const label = "label" in value ? value.label : undefined;
  if (typeof label !== "string" || !isStringKey(label)) {
    throw new TypeError(
      `Route handle: skipLink.label must be a microcopy key, got ${shown(label)}.`,
    );
  }
  return { href, label };
}

function readFooter(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`Route handle: footer must be true or false, got ${shown(value)}.`);
  }
  return value;
}

/**
 * Reads the part of a route's `handle` that the shell owns.
 *
 * @param value - The `handle` of one matched route. React Router does not type it, and other code
 *   may keep its own fields in it (or nothing at all).
 * @returns The `skipLink` and `footer` it carries; `{}` when it carries neither, or is not an
 *   object.
 * @throws {TypeError} If `skipLink` or `footer` is present but malformed. That is a developer error
 *   in the route that wrote it, so the route fails at once and says why; before, the shell took
 *   any object and failed later, far from the cause, inside `t(skip.label)`.
 */
export function readRouteHandle(value: unknown): RouteHandle {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const skipLink = "skipLink" in value ? readSkipLink(value.skipLink) : undefined;
  const footer = "footer" in value ? readFooter(value.footer) : undefined;
  return {
    ...(skipLink === undefined ? {} : { skipLink }),
    ...(footer === undefined ? {} : { footer }),
  };
}

/** The merged `handle` of the matched routes. */
export function useRouteHandle(): RouteHandle {
  return useMatches().reduce<RouteHandle>(
    (merged, match) => ({ ...merged, ...readRouteHandle(match.handle) }),
    {},
  );
}
