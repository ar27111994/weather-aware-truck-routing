import { describe, expect, it, vi } from "vitest";

import { createPlannerShell, HOST_SELECTOR, plannerShellOf } from "./planner-shell";

// R4-01 (D-46 3.1): a visit that arrives by navigating inside the app has no prerendered planner in
// its page. The shell is what the prerender drew, read once from the prerendered page, so that the
// page can show it at once while the planner's code is on the way.
const DRAWING = '<div data-planner-island=""><h1>Haulcast route planner</h1><form></form></div>';
const PAGE = `<!doctype html><html><body><header>Header</header><main><div class="host" data-planner-host="">${DRAWING}</div></main></body></html>`;

/** What the server answers for the planner's page. */
function answer(body: string, init: ResponseInit = { status: 200 }): typeof fetch {
  return vi.fn<typeof fetch>(() => Promise.resolve(new Response(body, init)));
}

describe("plannerShellOf", () => {
  it("is what the page holds in the element it keeps for the planner, and nothing around it", () => {
    expect(plannerShellOf(PAGE)).toBe(DRAWING);
  });

  it("is empty where the page has no drawing of the planner (a page that is not prerendered)", () => {
    expect(plannerShellOf("<html><body><main></main></body></html>")).toBe("");
  });

  it("finds the element by the selector the page's own element carries", () => {
    const host = new DOMParser().parseFromString(PAGE, "text/html").querySelector(HOST_SELECTOR);
    expect(host?.className).toBe("host");
  });
});

describe("createPlannerShell", () => {
  it("reads the shell from the planner's own page, as a page of HTML", async () => {
    const fetcher = answer(PAGE);

    const shell = await createPlannerShell(fetcher)();

    expect(shell).toBe(DRAWING);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/", { headers: { accept: "text/html" } });
  });

  it("asks once, however often the page needs it", async () => {
    const fetcher = answer(PAGE);
    const load = createPlannerShell(fetcher);

    const first = load();
    const second = load();
    await Promise.all([first, second]);
    await load();

    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails with the status when the server does not have the page", async () => {
    const load = createPlannerShell(answer("Gone", { status: 503 }));

    await expect(load()).rejects.toMatchObject({
      message: "The planner's page did not load.",
      cause: { message: "The planner's page answered 503." },
    });
  });

  it("fails when the network does, and keeps the cause", async () => {
    const cause = new TypeError("Failed to fetch");
    const load = createPlannerShell(() => Promise.reject(cause));

    await expect(load()).rejects.toMatchObject({
      message: "The planner's page did not load.",
      cause,
    });
  });

  it("asks again after a failure, so that a visitor who is back online gets the planner", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(PAGE, { status: 200 }));
    const load = createPlannerShell(fetcher);

    await expect(load()).rejects.toThrow("did not load");
    await expect(load()).resolves.toBe(DRAWING);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
