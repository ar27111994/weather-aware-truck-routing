/** The element that holds the planner in the page: the route keeps it for the planner (`PlannerIsland`). */
export const HOST_SELECTOR = "[data-planner-host]";

/** The page that the prerender drew the planner in. */
const PLANNER_PAGE = "/";

/**
 * The planner as a page drew it: what the page holds in the element it keeps for the planner. It is
 * empty where the page was not prerendered (the development server), and the planner then draws
 * itself.
 *
 * @param page - A page of HTML.
 */
export function plannerShellOf(page: string): string {
  const host = new DOMParser().parseFromString(page, "text/html").querySelector(HOST_SELECTOR);
  return host?.innerHTML ?? "";
}

async function read(fetcher: typeof fetch): Promise<string> {
  try {
    const response = await fetcher(PLANNER_PAGE, { headers: { accept: "text/html" } });
    if (!response.ok) throw new Error(`The planner's page answered ${String(response.status)}.`);
    return plannerShellOf(await response.text());
  } catch (error) {
    throw new Error("The planner's page did not load.", { cause: error });
  }
}

/**
 * The reader of the planner's shell: the planner as the prerender drew it, for a visit that
 * arrives by navigating inside the app (R4-01, D-46 3.1). That visit has no prerendered planner in
 * its page, and the planner's code is a download of seconds on a slow link. The page shows the
 * shell at once, and the planner's code takes it over when it arrives, the way it takes over the
 * prerendered page.
 *
 * The prerendered page is read once and kept for the life of the page. A read that failed is not
 * kept, so that a visitor who is back online gets the planner on the next try.
 *
 * @param fetcher - The browser's `fetch`; a test brings its own.
 * @returns The function that gives the shell: the same promise each time it is asked.
 */
export function createPlannerShell(
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
): () => Promise<string> {
  let shell: Promise<string> | null = null;
  return () => {
    shell ??= read(fetcher).catch((error: unknown) => {
      shell = null;
      throw error;
    });
    return shell;
  };
}

/** The shell of this page's visit, read from the prerendered page the first time it is needed. */
export const plannerShell = createPlannerShell();
