import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { MemoryRouter, Router, type Location, type Navigator } from "react-router";

import { createQueryClient } from "../../api/queries";
import { probe } from "../../probe";
import { ThemeProvider } from "../../design-system/foundation/ThemeProvider";
import { PlannerPage } from "./PlannerPage";

/**
 * The planner with the server-state cache it reads from. Only the planner talks to the API, so the
 * cache lives here and not in the root route: the shell is downloaded by every page, and the cache
 * library with the schema library behind it is not something the methodology page needs (N1).
 */
export default function PlannerApp(): ReactElement {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <PlannerPage />
    </QueryClientProvider>
  );
}

/**
 * What the planner takes from the page around it when it is a React root of its own: where the
 * address is, and how to change it. The page around it is the one with the router.
 */
export interface PlannerBridge {
  readonly location: Location;
  readonly navigator: Navigator;
}

/**
 * The planner as a React root of its own, with the two things the page around it provides: the
 * router and the theme. `bridge` is `null` where there is no page around it (the server's drawing,
 * which has no address to follow). The server and the browser draw the same markup from this tree,
 * which is what lets the browser take over the server's drawing without drawing it again.
 */
export function PlannerIslandTree({
  bridge,
}: {
  readonly bridge: PlannerBridge | null;
}): ReactElement {
  return (
    <ThemeProvider>
      {bridge === null ? (
        <MemoryRouter>
          <PlannerApp />
        </MemoryRouter>
      ) : (
        <Router location={bridge.location} navigator={bridge.navigator}>
          <PlannerApp />
        </Router>
      )}
    </ThemeProvider>
  );
}

/** A planner that was mounted: keep it in step with the page, and take it down. */
export interface PlannerMount {
  /** The page's address or its way of changing it is not the one it was given. */
  update(bridge: PlannerBridge): void;
  /** Takes the planner out of the page. */
  unmount(): void;
}

/**
 * Starts the planner in `host`. Where the server drew it (the host has the markup of
 * {@link PlannerIslandTree}) the planner takes that markup over, element for element, so what the
 * visitor typed into it and where the focus is stay as they are (D-46, D-47); where the host is
 * empty (a page that was not prerendered, as on the development server) the planner is drawn
 * into it.
 *
 * The planner is a root of its own, so the route's error boundary cannot see inside it: an error
 * that nothing in the planner catches ends the planner's root, and `onFailure` is how the page
 * learns of it, to show its error page (R4-03).
 *
 * @param host - The element that holds the server's drawing, or nothing.
 * @param bridge - The page's address and its way of changing it.
 * @param onFailure - Called with the error when the planner stops working.
 */
export function mountPlanner(
  host: HTMLElement,
  bridge: PlannerBridge,
  onFailure: (error: unknown) => void,
): PlannerMount {
  const tree = (current: PlannerBridge): ReactElement => <PlannerIslandTree bridge={current} />;
  const options = { onUncaughtError: onFailure };
  probe("mountPlanner", { hydrate: host.firstElementChild !== null });
  let root: Root;
  if (host.firstElementChild === null) {
    root = createRoot(host, options);
    root.render(tree(bridge));
  } else {
    root = hydrateRoot(host, tree(bridge), options);
  }
  return {
    update: (next) => {
      probe("mount.update", { path: next.location.pathname + next.location.search });
      root.render(tree(next));
    },
    unmount: () => {
      root.unmount();
    },
  };
}
